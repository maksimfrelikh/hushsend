import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, PulseGlyph, Waiting } from '../ui';

/**
 * The transient pre-connection states: `creating`, `joining`, `pairing` (key agreement / DTLS),
 * and `confirming` (key-confirmation, or — room method — waiting for the peer's SAS confirm). No
 * user action; the FSM advances on its own. The `pairing` state gets the "establishing channel"
 * lobby treatment (pulse + reassurance copy); the others are a simple spinner line.
 */
export function ConnectingScreen(): ReactElement {
  const t = useT();
  const status = useAppSelector((s) => s.connection.status);
  const method = useAppSelector((s) => s.connection.method);

  if (status === 'pairing') {
    return (
      <Screen center>
        <PulseGlyph />
        <Eyebrow parts={[t('lobbyEyebrow')]} />
        <h2 className="hs-h2">{t('lobbyTitle')}</h2>
        <p className="hs-sub">{t('lobbyDesc')}</p>
      </Screen>
    );
  }

  // confirming: on the room method the local human has already confirmed the SAS and is waiting
  // for the peer; elsewhere it's the brief key-confirmation exchange.
  const label =
    status === 'creating'
      ? t('creatingTitle')
      : status === 'joining'
        ? t('joiningTitle')
        : method === 'room'
          ? t('waitingPeerConfirm')
          : t('confirmingTitle');

  return (
    <Screen center>
      <Waiting label={label} />
    </Screen>
  );
}
