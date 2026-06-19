import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * UI-only record of the role THIS tab plays in a SAS comparison, so the screen can be asymmetric:
 * the CREATOR (initiator) is the **reader** — it is shown its phrase and reads it aloud — and the
 * JOINER (responder) is the **picker** — it stays BLIND to the phrase and must identify it among
 * three look-alikes by listening to the reader. Without this split the pick-from-3 gives no MITM
 * protection (a side that can see its own phrase would just click it without listening).
 *
 * This is purely a UI concern (which screen to render); it touches NO crypto/protocol/FSM. The role
 * is set at the moment the human starts a session (HomeScreen create/join handlers) and read by the
 * SAS screen. It lives in a context above the router so it survives HomeScreen unmounting. Default
 * is `picker` — fail-closed: an unset role never exposes the phrase.
 */
export type SasRole = 'reader' | 'picker';

interface SessionRoleApi {
  sasRole: SasRole;
  /** This tab created the rendezvous (initiator) → it reads its phrase aloud. */
  markCreator(): void;
  /** This tab joined an existing rendezvous (responder) → it is the blind picker. */
  markJoiner(): void;
}

const Ctx = createContext<SessionRoleApi | null>(null);

export function SessionRoleProvider({ children }: { children: ReactNode }) {
  const [sasRole, setSasRole] = useState<SasRole>('picker');
  const markCreator = useCallback(() => setSasRole('reader'), []);
  const markJoiner = useCallback(() => setSasRole('picker'), []);
  const value = useMemo<SessionRoleApi>(() => ({ sasRole, markCreator, markJoiner }), [sasRole, markCreator, markJoiner]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessionRole(): SessionRoleApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSessionRole must be used within <SessionRoleProvider>');
  return ctx;
}
