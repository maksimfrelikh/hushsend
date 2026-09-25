import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Eyebrow, PulseGlyph, Waiting, BackLink } from '../ui';

/**
 * The codeless reconnect while `awaitingPeer`: this device has taken the derived rendezvous and is
 * waiting for the other one to tap Reconnect too. Deliberately shows NO code and NO room name — the
 * rendezvous token is public routing derived from the pairing secret, but displaying it would only
 * invite someone to type it somewhere; there is nothing for a human to carry. The core re-takes the
 * room underneath (bucket boundaries, pre-TTL refresh) without this screen changing.
 */
export function ReconnectWaitScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  return (
    <Screen center>
      <PulseGlyph />
      <Eyebrow parts={[t('rwEyebrow')]} />
      <h2 className="hs-h2" data-testid="reconnect-waiting">
        {t('rwTitle')}
      </h2>
      <p className="hs-sub">{t('rwDesc')}</p>
      <Waiting label={t('rwWaiting')} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
