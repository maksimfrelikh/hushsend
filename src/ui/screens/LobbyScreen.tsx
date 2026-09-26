import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, Grow, BackLink, CopyPill, AlertLine, Glyph } from '../ui';

/**
 * Mesh-LOBBY view for the room method while `awaitingPeer`. The 4-digit code is the hero (mono,
 * capped for text zoom, wrapping to 2 × 2 when a row cannot hold it); several peers can sit in the
 * lobby, and BOTH the creator and every joiner land here and see the same thing: the code, Copy
 * code, and a roster of everyone else in the room. Each roster ROW is the tap target: picking a peer
 * raises a 1:1 channel with exactly that peer (`pickPeer`), which runs its own SAS — for ANY pair,
 * including joiner↔joiner (the per-pairing role decides who offers).
 *
 * A bounced pick (the peer is already pairing with someone else) surfaces as a one-time notice line
 * above the roster (role=alert), never as a row state; the picker is back in the lobby and may pick
 * another peer. This screen is for the PLAIN SAS room only — the codeless reconnect has its own wait
 * screen. The hard invariant is unchanged: no file UI here — only `connected` shows it.
 */
export function LobbyScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const room = useAppSelector((s) => s.connection.room) ?? '';
  const roster = useAppSelector((s) => s.connection.roster);
  const notice = useAppSelector((s) => s.connection.notice);

  return (
    <Screen>
      <h2 className="hs-h2">{t('lobbyRoomTitle')}</h2>
      <Space h={28} />
      <span
        className="hs-code"
        role="img"
        aria-label={`${t('roomCodeLabel')} ${room}`}
        data-testid="room-code"
      >
        {room.split('').map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </span>
      <Space h={20} />
      <CopyPill value={room} label={t('copyCode')} className="hs-half" />
      <Space h={32} />

      {notice?.kind === 'busy' && (
        <>
          <AlertLine testId="lobby-busy">
            {notice.peerId} {t('lobbyBusySuffix')}
          </AlertLine>
          <Space h={12} />
        </>
      )}

      {roster.length === 0 ? (
        <p className="hs-p hs-p--muted" data-testid="lobby-empty">
          {t('lobbyEmpty')}
        </p>
      ) : (
        <div className="hs-rows" data-testid="lobby-roster">
          {roster.map((peer) => (
            <div key={peer.id} data-testid={`lobby-peer-${peer.id}`}>
              <button
                type="button"
                className="hs-row"
                data-testid={`lobby-connect-${peer.id}`}
                onClick={() => session.pickPeer(peer.id)}
              >
                <span className="hs-row__body">
                  <span className="hs-row__title hs-row__title--mono">{peer.id}</span>
                  <span className="hs-row__desc">
                    {t('lobbyJoined')} {joinedClock(peer.joinedAt)}
                  </span>
                </span>
                <Glyph name="arrow" size={18} className="hs-row__arrow" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Grow />
      <Space h={20} />
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
