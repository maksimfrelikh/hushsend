import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, MeetDots, Pill } from '../ui';

/**
 * The transient pre-connection states: `creating`, `joining`, `pairing` (key agreement / DTLS) and
 * `confirming` (key-confirmation, or — room method — the peer's SAS confirm). The FSM advances on its
 * own; two dots meeting and one line, no waiting copy.
 *
 * One exception has a control: the SAS READER who confirmed before the picker answered waits here
 * ("Verifying…") — and must still be able to stop (TESTPLAN A4b). The core accepts a reject after our
 * own approval right up to settle; this is the pill that sends it, with the reader screen's copy.
 *
 * Privacy mode (step 6d): Max-privacy is STRICT — it never relays, so a direct ICE failure during
 * `pairing` is terminal and routes straight to the Failed screen (with a switch-to-Reliable hint),
 * NOT a relay-escalation offer here. So this screen has no relay UI.
 */
export function ConnectingScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const status = useAppSelector((s) => s.connection.status);
  const method = useAppSelector((s) => s.connection.method);
  const sasRole = useAppSelector((s) => s.connection.sasRole);
  const readerWaiting = status === 'confirming' && method === 'room' && sasRole === 'reader';
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
      {readerWaiting && (
        <>
          <Space h={36} />
          <div className="hs-connecting__actions">
            <Pill block testId="sas-waiting-abort" onClick={() => session.confirmSas(false)}>
              {t('sasReaderAbort')}
            </Pill>
          </div>
        </>
      )}
    </Screen>
  );
}
