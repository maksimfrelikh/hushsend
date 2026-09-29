import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { createSessionController } from '../core/SessionController';
import { parseLink } from '../core/link/link';
import { SessionProvider, useSession } from './SessionProvider';
import { PrefsProvider, usePrefs } from './prefs';
import { ScreenRouter } from './screens';
import { usePacedScreen } from './screens/usePacedScreen';
import { TopBar, StatusBeacon } from './ui';
import { Diagnostics } from './components/Diagnostics';
import { historyActions } from '../store/historySlice';

/**
 * The real, status-driven app. The single SessionController instance lives outside render and is
 * reached only through method calls; React reads serializable projections from the store. Screens
 * are chosen by the FSM status (ScreenRouter) — no URL router, no SSR.
 */
export function App(): ReactElement {
  const dispatch = useAppDispatch();
  const controller = useMemo(() => createSessionController(dispatch), [dispatch]);

  return (
    <PrefsProvider>
      <SessionProvider controller={controller}>
        <Shell />
      </SessionProvider>
    </PrefsProvider>
  );
}

/** Header + the single column. The reconnect key-changed hard stop inverts the WHOLE viewport
 *  (danger = inversion, never red): the shell carries that class so header and main both swap. It
 *  follows the SHOWN screen (screens/pacing.ts), so the viewport turns with the hard-stop screen
 *  itself, not up to half a second before it while the Connecting screen finishes. */
function Shell(): ReactElement {
  const paced = usePacedScreen();
  const shown = paced.pace.shown;
  const reconnectOutcome = useAppSelector((s) => s.dev.reconnect.outcome);
  const inverted =
    shown.kind === 'screen' && shown.status === 'failed' && reconnectOutcome === 'key-changed';
  return (
    <div className={`hs-app${inverted ? ' hs-app--inverted' : ''}`}>
      <TopBar />
      <main className="hs-main wrap">
        <ScreenRouter paced={paced} />
      </main>
      <Diagnostics />
      <StatusBeacon />
      <HistorySync />
      <PrivacyModeSync />
      <LinkFragmentJoin />
      <PageHideGoodbye />
    </div>
  );
}

/**
 * Leaving the page ends the session, so let the other side hear it at once: close the transport on
 * `pagehide` (see SessionController.closeOnPageHide for the 16 s it saves). A `persisted` pagehide is
 * a trip into the back/forward cache, not an ending — the session is left alone then. Renders nothing.
 */
function PageHideGoodbye(): null {
  const session = useSession();
  useEffect(() => {
    const onHide = (e: PageTransitionEvent): void => {
      if (!e.persisted) session.closeOnPageHide();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [session]);
  return null;
}

/**
 * Records completed transfers into the SESSION-ONLY history (in-memory Redux, NOT persisted — file
 * names are a privacy trail, so the history is gone on reload). Recent paired devices are NOT here —
 * they are read from the keystore (recentDevices.ts), the single source of pins/keys. Renders nothing.
 */
function HistorySync(): null {
  const dispatch = useAppDispatch();
  const phase = useAppSelector((s) => s.transfer.phase);
  const direction = useAppSelector((s) => s.transfer.direction);
  const fileName = useAppSelector((s) => s.transfer.fileName);
  const totalBytes = useAppSelector((s) => s.transfer.totalBytes);

  useEffect(() => {
    if (phase === 'done' && fileName) {
      const at = Date.now();
      dispatch(
        historyActions.remembered({
          id: `${at}-${fileName}`,
          fileName,
          totalBytes,
          direction: direction ?? 'send',
          at,
        }),
      );
    }
  }, [dispatch, phase, fileName, totalBytes, direction]);

  return null;
}

/**
 * Pushes the persisted privacy-mode pref (prefs.tsx) into the SessionController so it can read it at
 * pairing start to assemble iceServers. Keeps the persisted pref as the single source of truth (the
 * core just mirrors the current value). A mid-session toggle updates the core immediately but only
 * affects the NEXT connection (iceServers are read at pairing start). Renders nothing.
 */
function PrivacyModeSync(): null {
  const session = useSession();
  const { privacyMode } = usePrefs();
  useEffect(() => {
    session.setPrivacyMode(privacyMode);
  }, [session, privacyMode]);
  return null;
}

/**
 * link method (step 5b) entry: when the page loads with a `#<token>.<S>` fragment, the joiner
 * reads it, SCRUBS it from the address bar/history immediately (history.replaceState — the secret
 * never lingers in the URL, history, or a reload), and joins. Only the rendezvous token reaches the
 * server; S stays local. Runs exactly once (a ref guard survives StrictMode's double-invoke), and the
 * scrub before any async work means a re-run sees an empty hash. A malformed/absent fragment is a
 * no-op (stay on the home screen); a valid-but-dead link surfaces as the "room not found" failure
 * the moment the joiner finds the token room empty (token rooms are join-or-create, so the server
 * itself no longer says 4009 — SessionController.onWelcome does).
 *
 * The same happens when a link is opened into a tab that ALREADY shows hushsend (pasted into the
 * address bar, or tapped while the app is the current tab — iPadOS Safari does exactly that): only
 * the fragment differs, so the browser does a same-document navigation and nothing reloads — it
 * used to do nothing at all. `hashchange` catches it. The fragment is scrubbed at once whatever the
 * state; the join runs from the home screen and from a finished (failed) session, but never tears
 * down a session in progress or a live channel — a link pasted there is dropped, not followed.
 */
function LinkFragmentJoin(): null {
  const session = useSession();
  const status = useAppSelector((s) => s.connection.status);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const handled = useRef(false);

  useEffect(() => {
    const take = (): void => {
      const parsed = parseLink(window.location.hash);
      if (!parsed) return;
      // Scrub the secret out of the URL/history BEFORE any await — keep only path + query.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      const now = statusRef.current;
      if (now !== 'idle' && now !== 'failed') return;
      if (now === 'failed') session.dispose(); // back to idle: the failed session is over anyway
      void session.joinLinkSession(parsed.rendezvous, parsed.secret, 'link');
    };
    if (!handled.current) {
      handled.current = true;
      take();
    }
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, [session]);

  return null;
}
