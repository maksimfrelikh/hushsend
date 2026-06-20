import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink, Waiting, CopyButton, ShareButton } from '../ui';

/**
 * Host view for the link method (step 5b) while `awaitingPeer`. Shows the one-time invite link to
 * copy/share. The link is `<origin>/#<token>.<S>`: the rendezvous is a high-entropy 128-bit token
 * (unguessable, so strangers can't reach the room), and the part after `#` carries the high-entropy
 * secret S, which never reaches the server (browsers don't send the fragment) and which the joiner
 * scrubs from its address bar after reading. The link is single-use — one connection per link.
 *
 * `credential[0]` is the full link (the core builds it from the allocated token + S, the same way
 * the words method surfaces its secret words to the creator). A `link-url` mirror exposes the plain
 * URL for copy and for the e2e to read.
 */
export function LinkCreateScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const link = useAppSelector((s) => s.connection.credential)?.[0] ?? '';

  return (
    <Screen center>
      <Eyebrow parts={[t('lcrEyebrow')]} />
      <h2 className="hs-h2">{t('lcrTitle')}</h2>
      <p className="hs-sub">{t('lcrDesc')}</p>

      <div className="hs-linkbox">
        <span className="hs-linkbox__url" data-testid="link-url">
          {link}
        </span>
      </div>
      <div className="hs-row-actions">
        <CopyButton value={link} testId="copy-link-btn" />
        <ShareButton value={link} />
      </div>

      <Waiting label={t('waiting')} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
