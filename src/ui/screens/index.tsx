import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import type { ConnectionMethod } from '../../store/connectionSlice';
import { Screen, ScreenBusy } from '../ui';
import { HomeScreen } from './HomeScreen';
import { ReconnectWaitScreen } from './ReconnectWaitScreen';
import { LobbyScreen } from './LobbyScreen';
import { WordsCreateScreen } from './WordsCreateScreen';
import { ShareScreen } from './ShareScreen';
import { ConnectingScreen } from './ConnectingScreen';
import { SasScreen } from './SasScreen';
import { TransferScreen } from './TransferScreen';
import { FailedScreen } from './FailedScreen';
import type { Settled } from './pacing';
import type { PacedScreen } from './usePacedScreen';

/**
 * Screens are driven by connection.status (the FSM), NOT by a URL router — exactly as the
 * architecture requires — through the pacing in pacing.ts: a screen the FSM has just left is held
 * for a moment with its controls quiet, and the Connecting screen appears only when a pre-connection
 * stage outlasts that hold. The host-side `awaitingPeer` view additionally branches on the method
 * (words credential / the shared link+QR / the room lobby / the codeless reconnect wait). The hard
 * invariant holds structurally: only <TransferScreen> (status `connected`) renders the file UI, and
 * the pacing shows `connected` only while the status is `connected`, so no byte UI exists before
 * auth.
 *
 * The busy flag is provided around whatever is shown, in the same place every time, so holding a
 * screen never remounts it (its local state — typed words, a picked card — stays as it was).
 */
export function ScreenRouter({ paced }: { paced: PacedScreen }): ReactElement {
  const method = useAppSelector((s) => s.connection.method);
  const shown = paced.pace.shown;
  return (
    <ScreenBusy.Provider value={paced.busy}>
      {shown.kind === 'connecting' ? (
        <ConnectingScreen stage={shown.stage} />
      ) : shown.kind === 'blank' ? (
        <Screen>{null}</Screen>
      ) : (
        <SettledScreen status={shown.status} method={method} />
      )}
    </ScreenBusy.Provider>
  );
}

function SettledScreen({
  status,
  method,
}: {
  status: Settled;
  method: ConnectionMethod | null;
}): ReactElement {
  switch (status) {
    case 'idle':
      return <HomeScreen />;
    case 'awaitingPeer':
      switch (method) {
        case 'words':
          return <WordsCreateScreen />;
        case 'link':
        case 'qr':
          // Link and QR are ONE screen: the same one-time link, shown as a QR too.
          return <ShareScreen />;
        case 'reconnect':
          // Codeless: nothing to show but "waiting for the other device" (the rendezvous is derived).
          return <ReconnectWaitScreen />;
        default:
          return <LobbyScreen />;
      }
    case 'awaitingSas':
      return <SasScreen />;
    case 'connected':
      return <TransferScreen />;
    case 'failed':
      return <FailedScreen />;
  }
}
