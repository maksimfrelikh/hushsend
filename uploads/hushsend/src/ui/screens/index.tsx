import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import type { ConnectionStatus } from '../../store/connectionSlice';

function Placeholder({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <section className="screen">
      <h1>{title}</h1>
      {hint ? <p>{hint}</p> : null}
    </section>
  );
}

/**
 * Screens are driven by connection.status (the FSM), NOT by a URL router.
 * This Record is exhaustive over ConnectionStatus — add a status and TypeScript
 * forces you to give it a screen here.
 */
export function ScreenRouter(): ReactElement {
  const status = useAppSelector((s) => s.connection.status);

  const screens: Record<ConnectionStatus, ReactElement> = {
    idle: <Placeholder title="hushsend" hint="Home — pick a method: link · QR · words · room" />,
    creating: <Placeholder title="Creating session…" />,
    awaitingPeer: <Placeholder title="Share your words" hint="Read the words to the other person" />,
    joining: <Placeholder title="Enter the words" hint="Pick the words you were told" />,
    pairing: <Placeholder title="Connecting…" />,
    awaitingSas: <Placeholder title="Compare the code" hint="Room method: confirm the SAS matches" />,
    confirming: <Placeholder title="Verifying…" />,
    connected: <Placeholder title="Connected" hint="Transfer screen goes here" />,
    failed: <Placeholder title="Something went wrong" hint="See the error / retry" />,
  };

  return screens[status];
}
