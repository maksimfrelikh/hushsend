import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, MeetDots } from '../ui';

/**
 * The transient pre-connection states: `creating`, `joining`, `pairing` (key agreement / DTLS) and
 * `confirming` (key-confirmation, or — room method — the peer's SAS confirm). No user action; the
 * FSM advances on its own. Two dots meeting and one line; no waiting copy.
 *
 * Privacy mode (step 6d): Max-privacy is STRICT — it never relays, so a direct ICE failure during
 * `pairing` is terminal and routes straight to the Failed screen (with a switch-to-Reliable hint),
 * NOT a relay-escalation offer here. So this screen has no relay UI.
 */
export function ConnectingScreen(): ReactElement {
  const t = useT();
  const status = useAppSelector((s) => s.connection.status);
  const title =
    status === 'creating'
      ? t('creatingTitle')
      : status === 'joining'
        ? t('joiningTitle')
        : status === 'pairing'
          ? t('pairingTitle')
          : t('confirmingTitle');

  return (
    <Screen center>
      <MeetDots />
      <Space h={28} />
      <h2 className="hs-h3">{title}</h2>
    </Screen>
  );
}
