import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink, Waiting, CopyButton } from '../ui';

/**
 * Host view for the room method (4-digit rendezvous) while `awaitingPeer`. The code is PUBLIC
 * routing — the MITM defence is the SAS comparison after the peer joins. Also serves the reconnect
 * create path (same 4-digit rendezvous); reconnect just skips the SAS once both sides hold a pin.
 */
export function RoomCreateScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const room = useAppSelector((s) => s.connection.room) ?? '';

  return (
    <Screen center>
      <Eyebrow parts={[t('rcrEyebrow')]} />
      <h2 className="hs-h2">{t('rcrTitle')}</h2>

      <div className="hs-code" data-testid="room-code">
        {room.split('').map((d, i) => (
          <span key={i} className="hs-code__box">
            {d}
          </span>
        ))}
      </div>

      <CopyButton value={room} />

      <Waiting label={t('rcrWaiting')} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
