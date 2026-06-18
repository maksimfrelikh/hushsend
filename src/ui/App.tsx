import { useMemo } from 'react';
import { useAppDispatch } from '../store/hooks';
import { createSessionController } from '../core/SessionController';
import { SessionProvider } from './SessionProvider';
import { DevHarness } from './DevHarness';
// NOTE: step 1 renders the temporary transport harness instead of <ScreenRouter />
// (src/ui/screens). The real status-driven screens are wired back in at step 5.

export function App() {
  const dispatch = useAppDispatch();
  // The single SessionController instance — created once, lives outside render.
  const controller = useMemo(() => createSessionController(dispatch), [dispatch]);

  return (
    <SessionProvider controller={controller}>
      <main className="app">
        <DevHarness />
      </main>
    </SessionProvider>
  );
}
