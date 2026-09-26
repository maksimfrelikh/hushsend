import { expect, type Page } from '@playwright/test';

/* ============================================================
   Screen states for the visual and a11y gates.

   Both gates run against the Vite DEV server, where main.tsx
   exposes the store and the keystore on `window` (DEV-only, dead
   in the production bundle). A scene drives the FSM by dispatching
   the store's own actions, so every screen — including the ones
   that need a peer, a failed ICE path or a changed key — renders
   deterministically with no signaling server and no second tab.
   The e2e suite is where the real protocol is exercised; this is
   only about what each state LOOKS like and whether it is
   accessible.
   ============================================================ */

type Action = { type: string; payload?: unknown };
type Hooks = {
  __hsStore: { dispatch(action: Action): void };
  __hsKeystore: {
    putPin(
      pairingId: string,
      peerPublicKey: string,
      meta?: { label?: string; firstSeen?: number },
    ): Promise<unknown>;
  };
};

export type Theme = 'light' | 'dark';

export const THEMES: Theme[] = ['light', 'dark'];

export const VIEWPORTS = [
  { name: 'w375', width: 375, height: 812 }, // the base phone
  { name: 'w680', width: 680, height: 900 }, // top bar 64, gutter 34
  { name: 'w1440', width: 1440, height: 900 }, // gutter 72, single column max 520
] as const;

const LINK = 'https://hushsend.frelikh.dev/#k7Qm2vXa9LpR4nTdE0wYc3Hb.Zx1vP0yWq9LmN8tRbK3cD7Aa';
const WORDS = ['bathrobe', 'gadget', 'spider', 'ladder', 'digit'];
const PHRASE = 'bathrobe gadget spider';
const FILE = 'photos-2026-09.zip';
const SIZE = 48 * 1024 * 1024;

export async function dispatch(page: Page, ...actions: Action[]): Promise<void> {
  await page.evaluate((acts) => {
    const w = window as unknown as Hooks;
    for (const a of acts) w.__hsStore.dispatch(a);
  }, actions);
}

const conn = (type: string, payload?: unknown): Action => ({ type: `connection/${type}`, payload });
const tr = (type: string, payload?: unknown): Action => ({ type: `transfer/${type}`, payload });
const dev = (type: string, payload?: unknown): Action => ({ type: `dev/${type}`, payload });

/** idle → awaitingPeer for a method. */
const awaiting = (method: string, room: string, credential: string[] | null): Action[] => [
  conn('createStarted', { method }),
  conn('roomReady', { room, credential }),
];
/** … → connected (words method, a named peer). */
const connected: Action[] = [
  ...awaiting('words', 'bathrobe', WORDS),
  conn('pairingStarted', { peerId: 'brave-otter' }),
  conn('confirmStarted'),
  conn('connectionEstablished'),
];
const roomSas = (role: 'reader' | 'picker'): Action[] => [
  ...awaiting('room', '4827', null),
  conn('pairingStarted', { peerId: 'brave-otter' }),
  conn('sasRoleResolved', { role }),
  conn('sasReady', { sas: PHRASE }),
];
const failed = (method: string, reason: string, extra: Action[] = []): Action[] => [
  conn('createStarted', { method }),
  ...extra,
  conn('failed', { reason }),
];
const sending: Action[] = [
  ...connected,
  tr('offered', { direction: 'send', fileName: FILE, totalBytes: SIZE }),
  tr('accepted'),
  tr('progress', { transferredBytes: Math.round(SIZE * 0.26) }),
];

/** Pin two devices so the home shows its Reconnect section, then reload onto the seeded state. */
async function seedDevices(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as Hooks;
    await w.__hsKeystore.putPin('a'.repeat(32), '3b9f1c7e2a84d0f6'.padEnd(64, '9'), {
      label: 'Firefox · macOS',
      firstSeen: 200,
    });
    await w.__hsKeystore.putPin('b'.repeat(32), 'c81d0a4e5f27b93a'.padEnd(64, '7'), {
      label: 'Safari · iPhone',
      firstSeen: 100,
    });
  });
  await page.reload({ waitUntil: 'load' });
  await expect(page.getByTestId('reconnect-btn')).toBeVisible();
}

export type Scene = {
  name: string;
  /** every viewport (the core screens), or the base phone only (state variants) */
  matrix: 'full' | 'phone';
  setup: (page: Page) => Promise<void>;
  /** runs BEFORE the page loads (init scripts) */
  init?: (page: Page) => Promise<void>;
};

/**
 * The SAS picker draws two decoy phrases and their order from the CSPRNG, so its screenshot would
 * differ on every run (a long word wraps a card and moves everything under it). For THIS gate the
 * page's `crypto.getRandomValues` is replaced by a seeded xorshift before the bundle runs — the
 * scene then renders the same cards every time. Only the visual/a11y pages see this; nothing in the
 * app or its tests is touched.
 */
async function seedRandom(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let x = 0x9e3779b9;
    const next = (): number => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return x >>> 0;
    };
    crypto.getRandomValues = ((arr: ArrayBufferView) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff;
      return arr;
    }) as typeof crypto.getRandomValues;
  });
}

export const SCENES: Scene[] = [
  { name: 'home-empty', matrix: 'full', setup: async () => {} },
  { name: 'home-paired', matrix: 'full', setup: seedDevices },
  {
    name: 'home-reliable',
    matrix: 'phone',
    setup: async (page) => {
      await page.getByTestId('privacy-reliable').click();
    },
  },
  {
    name: 'method',
    matrix: 'full',
    setup: async (page) => {
      await page.getByTestId('invite-btn').click();
    },
  },
  {
    name: 'share',
    matrix: 'full',
    setup: (page) => dispatch(page, ...awaiting('link', 'k7Qm2vXa9LpR4nTdE0wYc3', [LINK])),
  },
  {
    name: 'scan',
    matrix: 'full',
    setup: async (page) => {
      await page.getByTestId('scan-qr-btn').click();
      // headless: no camera → the paste fallback is the state that renders
      await expect(page.getByTestId('scan-camera-error')).toBeVisible();
    },
  },
  {
    name: 'scan-invalid',
    matrix: 'phone',
    setup: async (page) => {
      await page.getByTestId('scan-qr-btn').click();
      await expect(page.getByTestId('scan-camera-error')).toBeVisible();
      await page.getByTestId('scan-paste-input').fill('https://hushsend.frelikh.dev/room/4827');
      await page.getByTestId('scan-paste-btn').click();
      await expect(page.getByTestId('scan-invalid')).toBeVisible();
    },
  },
  {
    name: 'words-read',
    matrix: 'full',
    setup: (page) => dispatch(page, ...awaiting('words', 'bathrobe', WORDS)),
  },
  {
    name: 'words-read-attempts',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...awaiting('words', 'bathrobe', WORDS),
        dev('setPairingAttempts', { attempts: 3, max: 10 }),
      ),
  },
  {
    name: 'words-enter',
    matrix: 'full',
    setup: async (page) => {
      await page.getByTestId('enter-words-btn').click();
      await page.getByTestId('word-input-0').fill('bathrobe');
      await page.getByTestId('word-input-0').press('Enter');
      await page.getByTestId('word-input-1').fill('gadget');
      await page.getByTestId('word-input-1').press('Enter');
      await page.getByTestId('word-input-2').fill('spi'); // inline completion → "der"
    },
  },
  {
    name: 'words-enter-nomatch',
    matrix: 'phone',
    setup: async (page) => {
      await page.getByTestId('enter-words-btn').click();
      await page.getByTestId('word-input-0').fill('bathrobe');
      await page.getByTestId('word-input-0').press('Enter');
      await page.getByTestId('word-input-1').fill('gadget');
      await page.getByTestId('word-input-1').press('Enter');
      await page.getByTestId('word-input-2').fill('spx');
    },
  },
  {
    name: 'words-enter-full',
    matrix: 'phone',
    setup: async (page) => {
      await page.getByTestId('enter-words-btn').click();
      for (let i = 0; i < WORDS.length; i++) {
        await page.getByTestId(`word-input-${i}`).fill(WORDS[i]);
        await page.getByTestId(`word-input-${i}`).press('Enter');
      }
      await page.getByTestId('words-join-btn').focus();
      await page.getByTestId('words-join-btn').blur();
    },
  },
  {
    name: 'lobby-empty',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...awaiting('room', '4827', null)),
  },
  {
    name: 'lobby',
    matrix: 'full',
    setup: (page) =>
      dispatch(
        page,
        ...awaiting('room', '4827', null),
        conn('rosterSet', [
          { id: 'brave-otter', device: 'Desktop', joinedAt: 1790000000000 },
          { id: 'calm-lynx', device: 'Mobile', joinedAt: 1790000060000 },
        ]),
      ),
  },
  {
    name: 'lobby-busy',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...awaiting('room', '4827', null),
        conn('rosterSet', [
          { id: 'brave-otter', device: 'Desktop', joinedAt: 1790000000000 },
          { id: 'calm-lynx', device: 'Mobile', joinedAt: 1790000060000 },
        ]),
        conn('lobbyNotice', { kind: 'busy', peerId: 'brave-otter' }),
      ),
  },
  {
    name: 'connecting',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...awaiting('words', 'bathrobe', WORDS),
        conn('pairingStarted', { peerId: 'brave-otter' }),
      ),
  },
  {
    name: 'reconnect-wait',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...awaiting('reconnect', 'tok', null)),
  },
  { name: 'sas-reader', matrix: 'full', setup: (page) => dispatch(page, ...roomSas('reader')) },
  {
    name: 'sas-picker',
    matrix: 'full',
    init: seedRandom,
    setup: (page) => dispatch(page, ...roomSas('picker')),
  },
  {
    name: 'sas-restart',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...awaiting('room', '4827', null),
        conn('pairingStarted', { peerId: 'x' }),
        conn('sasReady', { sas: PHRASE }),
      ),
  },
  { name: 'transfer-idle', matrix: 'full', setup: (page) => dispatch(page, ...connected) },
  {
    name: 'transfer-selected',
    matrix: 'phone',
    setup: async (page) => {
      await dispatch(page, ...connected);
      await page.getByTestId('file-input').setInputFiles([
        { name: FILE, mimeType: 'application/zip', buffer: Buffer.alloc(4096) },
        { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1024) },
      ]);
    },
  },
  { name: 'transfer-sending', matrix: 'full', setup: (page) => dispatch(page, ...sending) },
  {
    name: 'transfer-incoming',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...connected,
        tr('offered', { direction: 'receive', fileName: FILE, totalBytes: SIZE }),
      ),
  },
  {
    name: 'transfer-done',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...sending, tr('completed')),
  },
  {
    name: 'transfer-declined',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...connected,
        tr('offered', { direction: 'send', fileName: FILE, totalBytes: SIZE }),
        tr('rejected', { reason: 'declined by recipient' }),
      ),
  },
  {
    name: 'transfer-cancelled',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...sending, tr('cancelled')),
  },
  {
    name: 'transfer-error',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...sending, tr('failed', { reason: 'channel closed' })),
  },
  {
    name: 'transfer-path-unknown',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...connected, conn('pathSettled', { verdict: 'unknown' })),
  },
  {
    name: 'transfer-path-mismatch',
    matrix: 'phone',
    setup: async (page) => {
      await dispatch(page, ...connected, conn('pathSettled', { verdict: 'mismatch' }));
      await page.getByTestId('path-state').click(); // hint expanded
    },
  },
  {
    name: 'transfer-path-disagree',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...connected,
        conn('pathSettled', { verdict: 'mismatch' }),
        conn('stunDisagreement'),
      ),
  },
  {
    name: 'failed-direct',
    matrix: 'full',
    setup: (page) => dispatch(page, ...failed('words', "couldn't connect directly (Max privacy)")),
  },
  {
    name: 'failed-relay',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...failed('link', "couldn't connect directly (Max privacy)", [conn('relayUnavailable')]),
      ),
  },
  {
    name: 'failed-compromised',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...failed('room', 'key-confirmation mismatch: the channel may be compromised'),
      ),
  },
  {
    name: 'failed-room',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...failed('room', 'room not found (4009)')),
  },
  {
    name: 'failed-noshow',
    matrix: 'phone',
    setup: (page) =>
      dispatch(
        page,
        ...failed(
          'reconnect',
          'the other device did not show up — open hushsend there and tap Reconnect on this device',
        ),
      ),
  },
  {
    name: 'failed-generic',
    matrix: 'phone',
    setup: (page) => dispatch(page, ...failed('link', 'signaling closed 1006')),
  },
  {
    name: 'failed-words',
    matrix: 'phone',
    setup: (page) =>
      dispatch(page, ...failed('words', 'too many failed attempts — the words were invalidated')),
  },
  {
    name: 'key-changed',
    matrix: 'full',
    setup: (page) =>
      dispatch(
        page,
        ...failed(
          'reconnect',
          'key changed — the peer under this pairingId presented a different identity key',
          [dev('setReconnect', { active: true, outcome: 'key-changed' })],
        ),
      ),
  },
];

/** The three boards the owner checks at 200 % text zoom: every rem-based size doubles, the three
 *  display caps (room code, code words, phrase) hold. */
export const ZOOM_SCENES: Scene[] = [
  SCENES.find((s) => s.name === 'words-read')!,
  SCENES.find((s) => s.name === 'lobby')!,
  SCENES.find((s) => s.name === 'sas-reader')!,
];

/** Pin the theme before first paint the way the app's own prefs do (localStorage → data-theme). */
export async function pinTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('hushsend.theme', t as string);
    } catch {
      /* private mode — the markup default (light) applies */
    }
  }, theme);
}

/** Everything that has to be true before a stable capture or an honest contrast scan. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

export async function open(page: Page, theme: Theme, scene: Scene): Promise<void> {
  await pinTheme(page, theme);
  // The DEV diagnostics strip (tree-shaken from the production bundle) is not part of any screen:
  // hide it before first paint so neither the screenshots nor the axe scans see it.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '.hs-diag { display: none !important; }';
      document.head.append(style);
    });
  });
  await scene.init?.(page);
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await scene.setup(page);
  await settle(page);
}
