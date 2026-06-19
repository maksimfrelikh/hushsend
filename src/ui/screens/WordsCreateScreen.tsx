import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink, Waiting } from '../ui';

/**
 * Host view for the words method while `awaitingPeer`. Shows the full 5-word credential to read
 * aloud (word 1 = public rendezvous, words 2–5 = the secret CPace password) and the online-guessing
 * attempt counter. The words are presented as chips for the design; a screen-reader / test mirror
 * carries the plain phrase (testid `words`) so it can be read without the chip numbering.
 */
export function WordsCreateScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const credential = useAppSelector((s) => s.connection.credential) ?? [];
  const attempts = useAppSelector((s) => s.dev.pairingAttempts);
  const maxAttempts = useAppSelector((s) => s.dev.maxPairingAttempts);

  return (
    <Screen center>
      <Eyebrow parts={[t('wcrEyebrow')]} />
      <h2 className="hs-h2">{t('wcrTitle')}</h2>
      <p className="hs-sub">{t('wcrDesc')}</p>

      {/* plain phrase mirror (read-aloud / test hook), then the visual chips */}
      <span className="sr-only" data-testid="words">
        {credential.join(' ')}
      </span>
      <div className="hs-chips" aria-hidden="true">
        {credential.map((word, i) => (
          <span key={i} className="hs-chip">
            <span className="hs-chip__num">{String(i + 1).padStart(2, '0')}</span>
            <span className="hs-chip__word">{word}</span>
          </span>
        ))}
      </div>

      {maxAttempts > 0 && (
        <p className="hs-meta" data-testid="attempts">
          {t('attempts')} {attempts} / {maxAttempts}
        </p>
      )}

      <Waiting label={t('waiting')} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
