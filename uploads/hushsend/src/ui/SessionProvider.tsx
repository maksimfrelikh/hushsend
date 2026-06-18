import { createContext, useContext, type ReactNode } from 'react';
import type { SessionController } from '../core/SessionController';

const SessionContext = createContext<SessionController | null>(null);

export function SessionProvider({
  controller,
  children,
}: {
  controller: SessionController;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={controller}>{children}</SessionContext.Provider>;
}

/** UI calls the imperative core through this hook — it never touches live objects directly. */
export function useSession(): SessionController {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within <SessionProvider>');
  return ctx;
}
