import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { createSessionController } from '../core/SessionController';
import { parseLink } from '../core/link/link';
import { SessionProvider, useSession } from './SessionProvider';
import { PrefsProvider } from './prefs';
import { SessionRoleProvider } from './sessionRole';
import { ScreenRouter } from './screens';
import { TopBar, StatusBeacon } from './ui';
import { Diagnostics } from './components/Diagnostics';
import { rememberTransfer } from './persistence';

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
        <SessionRoleProvider>
          <div className="hs-app">
            <TopBar />
            <main className="hs-main">
              <ScreenRouter />
            </main>
            <Diagnostics />
            <StatusBeacon />
            <PersistenceSync />
            <LinkFragmentJoin />
          </div>
        </SessionRoleProvider>
      </SessionProvider>
    </PrefsProvider>
  );
}

/**
 * Records completed transfers into the localStorage history (NON-KEY metadata only). Recent paired
 * devices are NOT mirrored here — they are read from the keystore (recentDevices.ts), the single
 * source of pins/keys. Renders nothing.
 */
function PersistenceSync(): null {
  const phase = useAppSelector((s) => s.transfer.phase);
  const direction = useAppSelector((s) => s.transfer.direction);
  const fileName = useAppSelector((s) => s.transfer.fileName);
  const totalBytes = useAppSelector((s) => s.transfer.totalBytes);

  useEffect(() => {
    if (phase === 'done' && fileName) {
      rememberTransfer({ fileName, totalBytes, direction: direction ?? 'send' });
    }
  }, [phase, fileName, totalBytes, direction]);

  return null;
}

/**
 * link method (step 5b) entry: when the page loads with a `#<roomCode>.<S>` fragment, the joiner
 * reads it, SCRUBS it from the address bar/history immediately (history.replaceState — the secret
 * never lingers in the URL, history, or a reload), and joins. Only the roomCode reaches the server;
 * S stays local. Runs exactly once (a ref guard survives StrictMode's double-invoke), and the scrub
 * before any async work means a re-run sees an empty hash. A malformed/absent fragment is a no-op
 * (stay on the home screen); a valid-but-dead room surfaces later as the "room not found" failure.
 */
function LinkFragmentJoin(): null {
  const session = useSession();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const parsed = parseLink(window.location.hash);
    if (!parsed) return;
    // Scrub the secret out of the URL/history BEFORE any await — keep only path + query.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    void session.joinLinkSession(parsed.roomCode, parsed.secret, 'link');
  }, [session]);

  return null;
}
