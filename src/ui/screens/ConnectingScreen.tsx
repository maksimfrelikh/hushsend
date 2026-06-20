import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Eyebrow, PulseGlyph, Waiting } from '../ui';

/**
 * The transient pre-connection states: `creating`, `joining`, `pairing` (key agreement / DTLS),
 * and `confirming` (key-confirmation, or — room method — waiting for the peer's SAS confirm). No
 * user action; the FSM advances on its own. The `pairing` state gets the "establishing channel"
 * lobby treatment (pulse + reassurance copy); the others are a simple spinner line.
 *
 * relax-retry (step 6d): while `pairing`, a Max-privacy ICE failure surfaces a relay ESCALATION
 * (connection.relax.available) — status stays `pairing`, but we render the relax offer (accept /
 * decline). After accepting we wait for the peer (connection.relax.localRelaxed). This is a
 * projection, NOT a new FSM state.
 */
export function ConnectingScreen(): ReactElement {
  const t = useT();
  const status = useAppSelector((s) => s.connection.status);
  const method = useAppSelector((s) => s.connection.method);
  const relax = useAppSelector((s) => s.connection.relax);

  if (status === 'pairing') {
    if (relax.localRelaxed) return <RelaxWaiting />; // accepted relay — waiting for the relay path
    if (relax.available) return <RelaxOffer />; // ICE failed (or peer relaxed) — offer the relay
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

/**
 * relax-retry offer (Max-privacy STRICT model): the direct connection failed (or the peer relaxed
 * first). Offer to route through a relay — spelling out the trade-off — or decline (decline → failed:
 * Max-privacy would rather not connect than relay without consent). The relay only comes up once BOTH
 * sides accept (the other side keeps filtering until it does), so accepting may wait for the peer.
 */
function RelaxOffer(): ReactElement {
  const session = useSession();
  const t = useT();
  const peerRelaxed = useAppSelector((s) => s.connection.relax.peerRelaxed);
  return (
    <Screen center>
      <span className="hs-glyph hs-glyph--warn" aria-hidden="true">
        △
      </span>
      <Eyebrow parts={[t('relaxEyebrow')]} />
      <h2 className="hs-h2">{t('relaxTitle')}</h2>
      <p className="hs-sub" data-testid="relax-offer">
        {t('relaxDesc')}
      </p>
      {peerRelaxed && (
        <p className="hs-meta" data-testid="relax-peer-ready">
          {t('relaxPeerReady')}
        </p>
      )}
      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="relax-accept"
        onClick={() => void session.relaxConnection()}
      >
        {t('relaxAccept')}
      </button>
      <button type="button" className="hs-textlink" data-testid="relax-decline" onClick={() => session.declineRelax()}>
        {t('relaxDecline')}
      </button>
    </Screen>
  );
}

/** After accepting relay: waiting for the relay path (the peer must also accept before it forms). */
function RelaxWaiting(): ReactElement {
  const t = useT();
  return (
    <Screen center>
      <Waiting label={t('relaxWaiting')} />
      <p className="hs-sub" data-testid="relax-waiting">
        {t('relaxWaitingDesc')}
      </p>
    </Screen>
  );
}
