import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, MeetDots, Pill } from '../ui';
import type { Stage } from './pacing';

/**
 * The transient pre-connection states: `creating`, `joining`, `pairing` (key agreement / DTLS) and
 * `confirming` (key-confirmation, or — room method — the peer's SAS confirm). The FSM advances on its
 * own; two dots meeting and one line, no waiting copy.
 *
 * The router shows this screen only when a stage outlasts the hold, and `stage` is the PACED one
 * (pacing.ts): each title stays up at least TITLE_MIN_MS, a stage too short to read never gets its
 * title, and the screen stays up until its title has had its time — so it never flashes and its
 * line never flickers through three titles in a second.
 *
 * One exception has a control: the SAS READER who confirmed before the picker answered waits here
 * ("Verifying…") — and must still be able to stop (TESTPLAN A4b). The core accepts a reject after our
 * own approval right up to settle; this is the pill that sends it, with the reader screen's copy.
 * Once the FSM has moved past `confirming` the screen is held (inert), so the pill cannot send a
 * reject into a settled session.
 *
 * Privacy mode (step 6d): Max-privacy is STRICT — it never relays, so a direct ICE failure during
 * `pairing` is terminal and routes straight to the Failed screen (with a switch-to-Reliable hint),
 * NOT a relay-escalation offer here. So this screen has no relay UI.
 */
export function ConnectingScreen({ stage }: { stage: Stage }): ReactElement {
  const session = useSession();
  const t = useT();
  const method = useAppSelector((s) => s.connection.method);
  const sasRole = useAppSelector((s) => s.connection.sasRole);
  const readerWaiting = stage === 'confirming' && method === 'room' && sasRole === 'reader';
  const title =
    stage === 'creating'
      ? t('creatingTitle')
      : stage === 'joining'
        ? t('joiningTitle')
        : stage === 'pairing'
          ? t('pairingTitle')
          : t('confirmingTitle');

  return (
    <Screen center testId="connecting">
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
