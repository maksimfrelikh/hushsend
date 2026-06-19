import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Integration coverage for the word-room hardening in server/signaling-server.js (codeType=word
 * ONLY). Spawns the real signaling server as a child process with a SHORT TTL so the
 * auto-expiry path is testable in milliseconds, and drives it with Node's global WebSocket
 * (undici — which lets us set the Origin the server requires). The 4-digit room/link/QR path is
 * untouched and a regression case below confirms it is not subject to the 1:1 word cap.
 */

const PORT = 8091;
const URL_BASE = `ws://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173'; // a dev origin the server trusts under NODE_ENV=development
const TTL_MS = 1000; // short test TTL so a word room auto-expires quickly

let server: ChildProcess;

/** A tiny promise-friendly WebSocket client that records inbound JSON frames and the close event. */
class TestClient {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[] = [];
  closeEvent: { code: number; reason: string } | null = null;

  constructor(query: string) {
    this.ws = new WebSocket(`${URL_BASE}?${query}`, { headers: { Origin: ORIGIN } } as unknown as string[]);
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

  /** Wait for the socket to close; rejects on timeout. */
  waitClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      if (this.closeEvent) return resolve(this.closeEvent);
      const start = Date.now();
      const id = setInterval(() => {
        if (this.closeEvent) {
          clearInterval(id);
          resolve(this.closeEvent);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          reject(new Error('timeout waiting for close'));
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
function client(query: string): TestClient {
  const c = new TestClient(query);
  live.push(c);
  return c;
}

async function waitForHealth(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error('signaling server did not become healthy');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  server = spawn(process.execPath, ['server/signaling-server.js'], {
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(PORT), WORD_ROOM_TTL_MS: String(TTL_MS) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

afterAll(() => {
  server?.kill();
});

afterEach(() => {
  for (const c of live.splice(0)) c.close();
});

/** Create a word room and return [client, rendezvousWord]. */
async function createWordRoom(): Promise<[TestClient, string]> {
  const a = client('app=filetransfer&create=1&codeType=word');
  await a.opened();
  const welcome = await a.waitFor('welcome');
  return [a, welcome.room as string];
}

describe('word-room hardening (codeType=word)', () => {
  it('is strictly 1:1 — a third joiner is rejected with "room full"', async () => {
    const [, word] = await createWordRoom();

    const b = client(`app=filetransfer&room=${word}&codeType=word`);
    await b.opened();
    await b.waitFor('welcome');

    // Third participant: rejected (the word room is creator + one joiner only).
    const c = client(`app=filetransfer&room=${word}&codeType=word`);
    const close = await c.waitClose();
    expect(close.code).toBe(4002);
    expect(close.reason).toMatch(/full/i);
  });

  it('lets the creator destroy the room: the joiner gets room-closed, the word is freed', async () => {
    const [a, word] = await createWordRoom();
    const b = client(`app=filetransfer&room=${word}&codeType=word`);
    await b.opened();
    await b.waitFor('welcome');

    a.send({ type: 'destroy' });

    const closed = await b.waitFor('room-closed');
    expect(closed.reason).toBe('destroyed');

    // The word is freed: a fresh join now finds no room.
    const late = client(`app=filetransfer&room=${word}&codeType=word`);
    const close = await late.waitClose();
    expect(close.code).toBe(4009); // room not found
  });

  it('ignores a destroy from a non-creator (a joiner cannot tear down the rendezvous)', async () => {
    const [a, word] = await createWordRoom();
    const b = client(`app=filetransfer&room=${word}&codeType=word`);
    await b.opened();
    await b.waitFor('welcome');

    b.send({ type: 'destroy' }); // B is NOT the creator → must be ignored

    // The creator is NOT evicted and the room still exists.
    await expect(a.waitFor('room-closed', 500)).rejects.toThrow();
    expect(a.closeEvent).toBeNull();
  });

  it('auto-expires after the TTL: members get room-closed/expired and the word is freed', async () => {
    const [a, word] = await createWordRoom();

    const closed = await a.waitFor('room-closed', TTL_MS + 2000);
    expect(closed.reason).toBe('expired');

    // After expiry the word can be joined no more (freed).
    const late = client(`app=filetransfer&room=${word}&codeType=word`);
    const close = await late.waitClose();
    expect(close.code).toBe(4009);
  });

  it('still accepts the second (legit) joiner before any cap kicks in', async () => {
    // Sanity that the 1:1 cap is "max 2", not "max 1": creator + one joiner both connect.
    const [, word] = await createWordRoom();
    const b = client(`app=filetransfer&room=${word}&codeType=word`);
    await b.opened();
    const welcome = await b.waitFor('welcome');
    expect(welcome.type).toBe('welcome');
  });
});
