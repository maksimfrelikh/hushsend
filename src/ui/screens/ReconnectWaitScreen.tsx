import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Space, MeetDots, BackLink } from '../ui';

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
      <MeetDots />
      <Space h={28} />
      <h2 className="hs-h3" data-testid="reconnect-waiting">
        {t('rwTitle')}
      </h2>
      <Space h={12} />
      <p className="hs-p hs-p--muted hs-p--narrow">{t('rwDesc')}</p>
      <Space h={28} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
