import { chromium, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The spec's handle on the NAT lab that tests/nat/net/up.sh builds: switch a router's NAT rule,
 * MEASURE what the router then does, start a browser inside a client namespace.
 *
 * The addresses repeat tests/nat/net/lib.sh (the map of the lab is there) — keep the two in step.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The origin every browser loads: a port-forward inside its namespace, so it is a secure context
 *  and the origin the development signaling server allows. */
export const APP = 'http://localhost:5173';

export const ROUTER_WAN = { r1: '198.51.100.2', r2: '203.0.113.2' } as const;
export const CLIENT_NS = { r1: 'nat-c1', r2: 'nat-c2' } as const;
const REFLECTOR = ['192.0.2.1', '192.0.2.2'] as const;
const STUN = '192.0.2.10:3478';
const STATE_DIR = process.env.NAT_STATE_DIR ?? '/tmp/hushsend-nat';

export type Router = keyof typeof ROUTER_WAN;
/** The two rules of nat-mode.sh: `masquerade` and `masquerade fully-random`. */
export type NatRule = 'cone' | 'symmetric';
export type Behaviour = 'endpoint-independent' | 'address-dependent' | 'address-and-port-dependent';

export interface Measured {
  mapping: Behaviour;
  filtering: Behaviour;
  local: string;
  mapped: { first: string; otherPort: string; otherAddress: string; stun: string };
}

/** Fail before the first test with what to do, instead of four launch errors. */
export function requireLab(): void {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || !existsSync('/run/netns/nat-c1')) {
    throw new Error(
      'The NAT suite needs its lab: Linux, root, and tests/nat/net/up.sh already run. ' +
        'Use `sudo env "PATH=$PATH" bash tests/nat/run.sh` (README § The NAT suite); CI runs it in .github/workflows/nat.yml.',
    );
  }
}

export function setNat(router: Router, rule: NatRule): void {
  execFileSync('bash', [join(HERE, 'net/nat-mode.sh'), router, rule], { stdio: 'inherit' });
}

/** What the NAT in front of this router's client really does — tests/nat/tools/probe.ts. */
export function measure(router: Router): Measured {
  const out = execFileSync(
    'ip',
    ['netns', 'exec', CLIENT_NS[router], process.execPath, join(HERE, 'tools/probe.ts'), ...REFLECTOR, STUN],
    { encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '') as Measured;
}

/**
 * A Chromium whose whole network is one client namespace. Playwright drives the browser over
 * inherited pipes, and `ip netns exec` (bin/chromium-in-netns) only swaps the network before
 * exec — so the runner stays outside while every packet the browser sends crosses that
 * namespace's NAT. Root cannot use Chromium's sandbox; Playwright already launches without it.
 */
export function launchBehind(router: Router): Promise<Browser> {
  return chromium.launch({
    executablePath: join(HERE, 'bin/chromium-in-netns'),
    env: {
      ...(process.env as Record<string, string>),
      NAT_NETNS: CLIENT_NS[router],
      NAT_CHROMIUM: chromium.executablePath(),
    },
    // Real addresses in host candidates instead of mDNS names: they are useless across the two
    // LANs either way, but a candidate list a person can read is worth the flag.
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
}

/**
 * One line for whoever reads the run without its log. The job log of a public repository needs a
 * sign-in; annotations do not, so each case's measurements are published as one (the workflow
 * prints this file as workflow commands after the run). Outside CI it is just printed.
 */
export function annotate(level: 'notice' | 'error', title: string, message: string): void {
  const file = process.env.NAT_ANNOTATIONS;
  if (!file) {
    console.log(`[${level}] ${title}: ${message}`);
    return;
  }
  const data = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  appendFileSync(file, `::${level} title=${title.replace(/[,:]/g, ' ')}::${data}\n`);
}

/** The last lines the lab's servers wrote — for the diagnostics of a failed case. */
export function serverLogs(): string {
  const run = (cmd: string, args: string[]): string => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      return `(unavailable: ${(e as Error).message.split('\n')[0]})`;
    }
  };
  return [
    '--- signaling',
    run('tail', ['-n', '6', join(STATE_DIR, 'signaling.log')]),
    '--- coturn',
    run('sh', ['-c', 'docker logs --tail 12 nat-coturn 2>&1']),
  ].join('\n');
}
