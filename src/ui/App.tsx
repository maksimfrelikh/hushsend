import { useMemo } from 'react';
import { useAppDispatch } from '../store/hooks';
import { createSessionController } from '../core/SessionController';
import { SessionProvider } from './SessionProvider';
import { ScreenRouter } from './screens';

export function App() {
  const dispatch = useAppDispatch();
  // The single SessionController instance — created once, lives outside render.
  const controller = useMemo(() => createSessionController(dispatch), [dispatch]);

  return (
    <SessionProvider controller={controller}>
      <main className="app">
        <ScreenRouter />
      </main>
    </SessionProvider>
  );
}
