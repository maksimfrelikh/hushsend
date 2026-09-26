import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { HomeScreen } from './HomeScreen';
import { ReconnectWaitScreen } from './ReconnectWaitScreen';
import { LobbyScreen } from './LobbyScreen';
import { WordsCreateScreen } from './WordsCreateScreen';
import { ShareScreen } from './ShareScreen';
import { ConnectingScreen } from './ConnectingScreen';
import { SasScreen } from './SasScreen';
import { TransferScreen } from './TransferScreen';
import { FailedScreen } from './FailedScreen';

/**
 * Screens are driven by connection.status (the FSM), NOT by a URL router — exactly as the
 * architecture requires. The host-side `awaitingPeer` view additionally branches on the method
 * (words credential / the shared link+QR / the room lobby / the codeless reconnect wait). The hard
 * invariant holds structurally: only <TransferScreen> (status `connected`) renders the file UI, so
 * no byte UI exists before auth.
 */
export function ScreenRouter(): ReactElement {
  const status = useAppSelector((s) => s.connection.status);
  const method = useAppSelector((s) => s.connection.method);

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
    case 'creating':
    case 'joining':
    case 'pairing':
    case 'confirming':
      return <ConnectingScreen />;
  }
}
