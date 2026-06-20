import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink, CopyButton } from '../ui';

/**
 * Mesh-LOBBY view for the room method while `awaitingPeer`. The 4-digit code names a lobby that
 * several peers can sit in; BOTH the creator and every joiner land here (joining → awaitingPeer) and
 * see the same thing: the shareable code + a roster of everyone else in the room, each with a
 * "Connect" button. Picking a peer raises a 1:1 channel with exactly that peer (`pickPeer`), which
 * runs its own SAS — for ANY pair, including joiner↔joiner (the per-pairing role decides who offers).
 *
 * This screen is for the PLAIN SAS room only. The reconnect create path (also room + awaitingPeer)
 * keeps the simple code screen (RoomCreateScreen) — reconnect auto-pairs 1:1, no pick. words/link/qr
 * are not lobbies at all. The hard invariant is unchanged: no file UI here — only `connected` shows it.
 */
export function LobbyScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const room = useAppSelector((s) => s.connection.room) ?? '';
  const roster = useAppSelector((s) => s.connection.roster);
  const notice = useAppSelector((s) => s.connection.notice);

  return (
    <Screen center>
      <Eyebrow parts={[t('lobbyRoomEyebrow')]} />
      <h2 className="hs-h2">{t('lobbyRoomTitle')}</h2>

      <div className="hs-code" data-testid="room-code">
        {room.split('').map((d, i) => (
          <span key={i} className="hs-code__box">
            {d}
          </span>
        ))}
      </div>
      <CopyButton value={room} />

      {notice?.kind === 'busy' && (
        <p className="hs-meta hs-meta--warn" data-testid="lobby-busy">
          {t('lobbyBusyPrefix')} {notice.peerId} {t('lobbyBusySuffix')}
        </p>
      )}

      {roster.length === 0 ? (
        <p className="hs-sub" data-testid="lobby-empty">
          {t('lobbyEmpty')}
        </p>
      ) : (
        <div className="hs-stack" data-testid="lobby-roster">
          {roster.map((peer) => (
            <div key={peer.id} className="hs-device" data-testid={`lobby-peer-${peer.id}`}>
              <span className="hs-dot hs-dot--on" aria-hidden="true" />
              <div className="hs-row__body">
                <div className="hs-row__title">{peer.id}</div>
                <div className="hs-meta">
                  {peer.device || t('lobbyDeviceUnknown')} · {t('lobbyJoined')} {joinedClock(peer.joinedAt)}
                </div>
              </div>
              <button
                type="button"
                className="hs-btn hs-btn--primary hs-btn--sm"
                data-testid={`lobby-connect-${peer.id}`}
                onClick={() => session.pickPeer(peer.id)}
              >
                {t('lobbyConnect')}
              </button>
            </div>
          ))}
        </div>
      )}

      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}

/** A short local clock label (HH:MM) for a server `joinedAt` timestamp. Cosmetic; not asserted. */
function joinedClock(joinedAt: number): string {
  try {
    return new Date(joinedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}
