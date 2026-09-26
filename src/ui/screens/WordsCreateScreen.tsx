import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, Grow, BackLink, AlertLine } from '../ui';

/**
 * Host view for the words method while `awaitingPeer`: the five words to read aloud, numbered, as
 * the biggest text on the screen (word 1 = public rendezvous, words 2–5 = the secret CPace
 * password). NO copy button — the words are spoken, never pasted. After a wrong guess the attempt
 * counter appears above them (online-guessing bound). Waiting for the peer is implied.
 *
 * A screen-reader / test mirror carries the plain phrase (testid `words`), so it can be read without
 * the numbering; the visual list is hidden from the tree to avoid reading it twice.
 */
export function WordsCreateScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const credential = useAppSelector((s) => s.connection.credential) ?? [];
  const attempts = useAppSelector((s) => s.dev.pairingAttempts);
  const maxAttempts = useAppSelector((s) => s.dev.maxPairingAttempts);

  return (
    <Screen>
      <h2 className="hs-h2">{t('wcrTitle')}</h2>
      {attempts > 0 && (
        <>
          <Space h={12} />
          <AlertLine testId="attempts">
            {attempts} / {maxAttempts} {t('attemptsSuffix')}
          </AlertLine>
        </>
      )}
      <Space h={28} />
      <p className="sr-only" data-testid="words">
        {credential.join(' ')}
      </p>
      <ol className="hs-words" aria-hidden="true">
        {credential.map((word, i) => (
          <li key={i} className="hs-words__row">
            <span className="hs-words__num">{i + 1}</span>
            <span className="hs-words__word">{word}</span>
          </li>
        ))}
      </ol>
      <Grow />
      <Space h={20} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
