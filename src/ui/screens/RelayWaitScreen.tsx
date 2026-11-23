import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Space, MeetDots, TextLink, BackLink } from '../ui';

/**
 * "Retry with relay", tapped on this side first: it waits at the retry rendezvous for the peer's own
 * tap (README § Max-privacy strict model). Nothing to show and nothing to carry — the rendezvous is
 * derived from the failed attempt — so the screen says the one thing the peer has to do. "Start over
 * instead" is the fallback for a peer that is gone: a new invite in Reliable (or home, for the side
 * that was invited).
 */
export function RelayWaitScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  return (
    <Screen center>
      <MeetDots />
      <Space h={28} />
      <h2 className="hs-h3" data-testid="relay-waiting">
        {t('relayWaitTitle')}
      </h2>
      <Space h={12} />
      <p className="hs-p hs-p--muted hs-p--narrow">{t('relayWaitDesc')}</p>
      <Space h={12} />
      <p className="hs-p hs-p--muted hs-p--narrow">{t('relayWaitFallback')}</p>
      <Space h={20} />
      <TextLink testId="start-over-btn" onClick={() => void session.startOverWithRelay()}>
        {t('startOverInstead')}
      </TextLink>
      <Space h={28} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
