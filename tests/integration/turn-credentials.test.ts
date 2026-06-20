import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';

/**
 * Integration coverage for the `turn-request` → `turn-credentials` handler in
 * server/signaling-server.js (step 6d, server side). The signaling server mints SHORT-LIVED coturn
 * credentials (use-auth-secret / "REST API" scheme) so a 1:1 pair that can't connect directly can
 * fall back to a relay in Reliable mode:
 *   - username = a FUTURE unix-expiry (Math.floor(now/1000) + TURN_CRED_TTL_S);
 *   - credential = base64(HMAC-SHA1(TURN_SECRET, username)) — coturn recomputes this + checks expiry;
 *   - the shared TURN_SECRET lives ONLY on the server; only the derived per-session credential is sent.
 * When TURN is unconfigured (empty TURN_SECRET) the server answers with EMPTY urls so the client
 * stays direct-only — never an error. The handler is gated on `cfg.managed` (filetransfer) and is
 * bounded by the existing per-socket message rate-limit (no separate limiter).
 *
 * Each concern spawns its OWN signaling server (own port + env) and drives it with Node's global
 * WebSocket (undici), setting the Origin the server requires.
 */

const ORIGIN = 'http://localhost:5173'; // a dev origin the server trusts under NODE_ENV=development

/** A tiny promise-friendly WebSocket client that records inbound JSON frames and the close event. */
class TestClient {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[] = [];
  closeEvent: { code: number; reason: string } | null = null;

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers } as unknown as string[]);
    this.ws.onmessage = (e) => {
      try {
        this.messages.push(JSON.parse(String(e.data)));
      } catch {
        /* ignore non-JSON */
      }
    };
    this.ws.onclose = (e) => {
      this.closeEvent = { code: e.code, reason: e.reason };
    };
    this.ws.onerror = () => {}; // a connection error surfaces as a close; don't crash the test
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('close', (e) => reject(new Error(`closed before open: ${e.code}`)), { once: true });
    });
  }

  /** Wait for a frame whose `type` matches; rejects on timeout. */
  waitFor(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const found = this.messages.find((m) => m.type === type);
      if (found) return resolve(found);
      const start = Date.now();
      const id = setInterval(() => {
        const hit = this.messages.find((m) => m.type === type);
        if (hit) {
          clearInterval(id);
          resolve(hit);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          reject(new Error(`timeout waiting for '${type}'`));
        }
      }, 20);
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

const live: TestClient[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.close();
});

function client(port: number, query: string): TestClient {
  const c = new TestClient(`ws://127.0.0.1:${port}?${query}`, { Origin: ORIGIN });
  live.push(c);
  return c;
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`signaling server on :${port} did not become healthy`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startServer(port: number, extraEnv: Record<string, string>): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['server/signaling-server.js'], {
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
  await waitForHealth(port);
  return proc;
}

/** Create a 4-digit room and return the live socket (the message handler is attached after join). */
async function createRoom(port: number): Promise<TestClient> {
  const a = client(port, 'app=filetransfer&create=1');
  await a.opened();
  await a.waitFor('welcome');
  return a;
}

describe('turn-request → turn-credentials (configured)', () => {
  const PORT = 8099;
  const SECRET = 'test-shared-secret-deadbeef';
  const URLS = 'turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp';
  const TTL = '7200';
  let server: ChildProcess;
  beforeAll(async () => {
    server = await startServer(PORT, { TURN_SECRET: SECRET, TURN_URLS: URLS, TURN_CRED_TTL_S: TTL });
  });
  afterAll(() => {
    server?.kill();
  });

  it('returns short-lived coturn creds: urls array, future-expiry username, recomputable HMAC credential, ttl', async () => {
    const a = await createRoom(PORT);
    const beforeS = Math.floor(Date.now() / 1000);
    a.send({ type: 'turn-request' });
    const creds = (await a.waitFor('turn-credentials')) as unknown as {
      urls: string[];
      username: string;
      credential: string;
      ttl: number;
    };

    // urls are the comma-separated TURN_URLS parsed into an array.
    expect(creds.urls).toEqual([
      'turn:turn.example.org:3478?transport=udp',
      'turn:turn.example.org:3478?transport=tcp',
    ]);
    // ttl echoes TURN_CRED_TTL_S.
    expect(creds.ttl).toBe(Number(TTL));
    // username is a FUTURE unix-expiry ≈ now + ttl (coturn validates this).
    const expiry = Number(creds.username);
    expect(Number.isInteger(expiry)).toBe(true);
    expect(expiry).toBeGreaterThanOrEqual(beforeS + Number(TTL));
    expect(expiry).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + Number(TTL) + 2);
    // credential == base64(HMAC-SHA1(secret, username)) — recompute exactly as coturn would.
    const expected = createHmac('sha1', SECRET).update(creds.username).digest('base64');
    expect(creds.credential).toBe(expected);
    expect(creds.credential.length).toBeGreaterThan(0);
  });
});

describe('turn-request → turn-credentials (unconfigured)', () => {
  const PORT = 8100;
  let server: ChildProcess;
  beforeAll(async () => {
    // No TURN_SECRET → relay disabled. The server must still answer gracefully (empty), never error.
    server = await startServer(PORT, {});
  });
  afterAll(() => {
    server?.kill();
  });

  it('answers with empty urls/credential when TURN_SECRET is unset → client stays direct-only', async () => {
    const a = await createRoom(PORT);
    a.send({ type: 'turn-request' });
    const creds = (await a.waitFor('turn-credentials')) as unknown as {
      urls: string[];
      username: string;
      credential: string;
      ttl: number;
    };
    expect(creds.urls).toEqual([]);
    expect(creds.username).toBe('');
    expect(creds.credential).toBe('');
    expect(creds.ttl).toBe(0);
  });
});
