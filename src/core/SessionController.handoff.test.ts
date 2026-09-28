import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppDispatch } from '../store';
import { transferActions } from '../store/transferSlice';

/**
 * Handing a finished file to the user (owner's decision 2026-09-27, option A).
 *
 * Normally the controller starts the download the moment a receive completes. But iOS drops a
 * download a page starts while it is HIDDEN (screen locked, another app in front): in the F1
 * rehearsal the transfer finished and the file simply vanished, with no prompt and no error. So a
 * hidden page holds the file and shows "Save file"; the tap — a real user gesture — hands it over.
 * A held file nobody saves is discarded on "New transfer" and on session end; one that was handed
 * over is released (on the OPFS path: removed after the browser has had time to read it).
 */

const hoisted = vi.hoisted(() => {
  class MockPeerConnection {
    constructor(_handlers: unknown, _config: unknown) {}
  }
  return { MockPeerConnection, triggerDownload: vi.fn() };
});
vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));
vi.mock('./transfer/fileTransfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transfer/fileTransfer')>()),
  triggerDownload: hoisted.triggerDownload,
}));

import { SessionController } from './SessionController';
import type { ReceiveEvent } from './transfer/fileTransfer';

interface SCInternals {
  onReceiveEvent(e: ReceiveEvent): void;
}

function setup(visibility: 'visible' | 'hidden') {
  vi.stubGlobal('document', { visibilityState: visibility });
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const release = vi.fn();
  const discard = vi.fn();
  const handoff = { file: new Blob(['hello']), name: 'a.txt', holdMs: 600_000, release, discard };
  const finish = (): void => (sc as unknown as SCInternals).onReceiveEvent({ t: 'done', handoff });
  return { sc, dispatch, handoff, release, discard, finish };
}

describe('SessionController — handing a received file to the user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a visible page downloads at once and lets the file go', () => {
    const { finish, release, discard, dispatch } = setup('visible');
    finish();
    // The download's link lives as long as the file does (a browser that asks first fetches late).
    expect(hoisted.triggerDownload).toHaveBeenCalledWith(expect.any(Blob), 'a.txt', 600_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(transferActions.saveNeeded(true));
  });

  it('a HIDDEN page holds the file and asks for a tap instead — iOS would drop the download', () => {
    const { sc, finish, release, dispatch } = setup('hidden');
    finish();
    expect(hoisted.triggerDownload).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(transferActions.saveNeeded(true));

    sc.saveReceived(); // the tap on "Save file"
    // The download's link lives as long as the file does (a browser that asks first fetches late).
    expect(hoisted.triggerDownload).toHaveBeenCalledWith(expect.any(Blob), 'a.txt', 600_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(transferActions.saveNeeded(false));
    sc.saveReceived(); // a second tap has nothing left to save
    expect(hoisted.triggerDownload).toHaveBeenCalledTimes(1);
  });

  it('a held file nobody saved is discarded on "New transfer"', () => {
    const { sc, finish, discard, release, dispatch } = setup('hidden');
    finish();
    sc.resetTransfer();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(hoisted.triggerDownload).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(transferActions.reset());
  });

  it('…and when the session ends', () => {
    const { sc, finish, discard } = setup('hidden');
    finish();
    sc.dispose();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('a file already saved — through the dialog, or streamed straight into Downloads — needs nothing', () => {
    const { sc } = setup('visible');
    (sc as unknown as SCInternals).onReceiveEvent({ t: 'done', handoff: null });
    expect(hoisted.triggerDownload).not.toHaveBeenCalled();
  });
});
