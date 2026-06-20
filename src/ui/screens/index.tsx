import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { HomeScreen } from './HomeScreen';
import { RoomCreateScreen } from './RoomCreateScreen';
import { LobbyScreen } from './LobbyScreen';
import { WordsCreateScreen } from './WordsCreateScreen';
import { LinkCreateScreen } from './LinkCreateScreen';
import { QrCreateScreen } from './QrCreateScreen';
import { ConnectingScreen } from './ConnectingScreen';
import { SasScreen } from './SasScreen';
import { TransferScreen } from './TransferScreen';
import { FailedScreen } from './FailedScreen';

/**
 * Screens are driven by connection.status (the FSM), NOT by a URL router — exactly as the
 * architecture requires. The host-side `awaitingPeer` view additionally branches on the method
 * (words credential / link / qr / 4-digit room code). The hard invariant holds structurally: only
 * <TransferScreen> (status `connected`) renders the file UI, so no byte UI exists before auth.
 */
export function ScreenRouter(): ReactElement {
  const status = useAppSelector((s) => s.connection.status);
  const method = useAppSelector((s) => s.connection.method);
  // Reconnect (also room + awaitingPeer) auto-pairs 1:1 with NO human pick, so it keeps the simple
  // code screen; the plain SAS room is a mesh LOBBY (roster + pick). reconnect.active distinguishes
  // them. (reconnect-in-lobby — letting lobby picks reconnect — is deferred.)
  const reconnectActive = useAppSelector((s) => s.dev.reconnect.active);

  switch (status) {
    case 'idle':
      return <HomeScreen />;
    case 'awaitingPeer':
      switch (method) {
        case 'words':
          return <WordsCreateScreen />;
        case 'link':
          return <LinkCreateScreen />;
        case 'qr':
          return <QrCreateScreen />;
        default:
          return reconnectActive ? <RoomCreateScreen /> : <LobbyScreen />;
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
