import { type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow } from '../ui';

/**
 * Terminal failure screen. The reconnect KEY-CHANGED case is a distinct, prominent hard stop (an
 * inverted danger block, never a toast — no bytes ever flow). Other failures are classified from
 * the error text into a MITM/mismatch danger variant, a room-not-found variant, or a generic
 * variant; each surfaces the raw error and an exit. Words failures additionally offer fresh words.
 */
export function FailedScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const error = useAppSelector((s) => s.connection.error) ?? '';
  const method = useAppSelector((s) => s.connection.method);
  const reconnectOutcome = useAppSelector((s) => s.dev.reconnect.outcome);

  if (reconnectOutcome === 'key-changed') {
    return (
      <Screen center>
        <div className="hs-center" data-testid="key-changed">
          <span className="hs-glyph hs-glyph--danger" aria-hidden="true">
            ⚿
          </span>
          <Eyebrow parts={[t('kcEyebrow')]} />
          <h2 className="hs-h2">{t('kcTitle')}</h2>
          <p className="hs-sub">{t('kcDesc')}</p>
          <p className="hs-meta" data-testid="error">
            {error}
          </p>
        </div>
        <button type="button" className="hs-btn hs-btn--primary" onClick={() => session.dispose()}>
          {t('kcAbort')}
        </button>
      </Screen>
    );
  }

  const lower = error.toLowerCase();
  const isMismatch = /(match|man-in-the-middle|tamper|mismatch|compromis)/.test(lower);
  const isExpired = /(not found|expired|4009|room full|signaling closed)/.test(lower);

  const eyebrow = isMismatch ? t('erMismatchEyebrow') : isExpired ? t('exEyebrow') : t('erGenericEyebrow');
  const title = isMismatch ? t('erMismatchTitle') : isExpired ? t('exTitle') : t('erGenericTitle');
  const desc = isMismatch ? t('erMismatchDesc') : isExpired ? t('exDesc') : '';
  const glyphClass = isMismatch ? 'hs-glyph hs-glyph--warn' : 'hs-glyph';
  const glyph = isMismatch ? '△' : isExpired ? '⌕' : '!';

  return (
    <Screen center>
      <span className={glyphClass} aria-hidden="true">
        {glyph}
      </span>
      <Eyebrow parts={[eyebrow]} />
      <h2 className="hs-h2">{title}</h2>
      {desc && <p className="hs-sub">{desc}</p>}
      <p className="hs-meta" data-testid="error">
        {error}
      </p>
      <div className="hs-row-actions">
        {method === 'words' && (
          <button
            type="button"
            className="hs-btn hs-btn--primary"
            data-testid="new-words-btn"
            onClick={() => void session.regenerate()}
          >
            {t('newWords')}
          </button>
        )}
        <button
          type="button"
          className={method === 'words' ? 'hs-btn hs-btn--ghost' : 'hs-btn hs-btn--primary'}
          data-testid="reset-btn"
          onClick={() => session.dispose()}
        >
          {t('backHome')}
        </button>
      </div>
    </Screen>
  );
}
