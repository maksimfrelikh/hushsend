import { useMemo, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { useSessionRole } from '../sessionRole';
import { Screen, Eyebrow, BackLink } from '../ui';
import { buildSasOptions, sasSelectionOk } from '../sasOptions';

/**
 * Room-method SAS comparison, ASYMMETRIC so the "pick from 3" actually protects against a MITM:
 *
 *  - the CREATOR (initiator) is the **reader** — it is shown its phrase and reads the three words
 *    aloud to its peer;
 *  - the JOINER (responder) is the **picker** — it is BLIND to the phrase and must identify it
 *    among three indistinguishable options by listening to the reader.
 *
 * If the picker could see its own phrase it would just click it without listening, and a MITM
 * (which makes the two sides derive DIFFERENT phrases) would go undetected. By splitting the roles,
 * a MITM is caught: the picker hears the reader's phrase, finds it is NOT among its options (its own
 * derived phrase differs), and picks "none of these" → `confirmSas(false)` → both abort.
 *
 * The crypto/protocol are unchanged: the real phrase still comes from the store (`connection.sas`),
 * `sas.ts` is untouched, and both sides still gate on the mutual `sas-confirm{ok}`. `ok=true` is
 * sent only when the picker selects the real phrase (or the reader confirms its peer found it).
 */
export function SasScreen(): ReactElement {
  const { sasRole } = useSessionRole();
  return sasRole === 'reader' ? <ReaderView /> : <PickerView />;
}

/** Reader (creator): shown the real phrase to read aloud. NOT a picker — it cannot be tricked into
 *  picking, it only reads + confirms (and can abort if the peer reports no match). */
function ReaderView(): ReactElement {
  const session = useSession();
  const t = useT();
  const real = useAppSelector((s) => s.connection.sas) ?? '';

  return (
    <Screen center>
      <Eyebrow parts={[t('sasEyebrow')]} />
      <h2 className="hs-h2">{t('sasReaderTitle')}</h2>
      <p className="hs-sub">{t('sasReaderDesc')}</p>

      <p className="hs-eyebrow">{t('sasYours')}</p>
      <p className="hs-ownphrase" data-testid="sas-words">
        {real}
      </p>

      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="sas-reader-confirm"
        onClick={() => session.confirmSas(true)}
      >
        {t('sasReaderConfirm')}
      </button>
      <button
        type="button"
        className="hs-textlink"
        data-testid="sas-reader-abort"
        onClick={() => session.confirmSas(false)}
      >
        {t('sasReaderAbort')}
      </button>
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}

/** Picker (joiner): BLIND. The real phrase is NEVER shown on its own — only as one of three
 *  indistinguishable options. The human must pick the phrase they HEAR the reader read aloud. */
function PickerView(): ReactElement {
  const session = useSession();
  const t = useT();
  // `real` is read for SCORING/option-building only — it is deliberately NOT rendered anywhere on
  // the picker's screen (it appears solely as one of the three look-alike options).
  const real = useAppSelector((s) => s.connection.sas) ?? '';
  // Built ONCE per shown SAS (deps: real) — selecting a card re-renders but never reshuffles.
  const options = useMemo(() => buildSasOptions(real), [real]);
  const [selected, setSelected] = useState<number | null>(null);

  const onConfirm = (): void => {
    if (selected === null) return;
    // ok=true ONLY if the picked card is the real phrase (sasSelectionOk); a decoy → false.
    session.confirmSas(sasSelectionOk(options, selected, real));
  };

  return (
    <Screen center>
      <Eyebrow parts={[t('sasEyebrow')]} />
      <h2 className="hs-h2">{t('sasTitle')}</h2>
      <p className="hs-sub">{t('sasDesc')}</p>

      <div className="hs-sas">
        {options.map((phrase, i) => (
          <button
            key={i}
            type="button"
            className="hs-sas__card"
            aria-pressed={selected === i}
            data-testid={`sas-option-${i}`}
            onClick={() => setSelected(i)}
          >
            {phrase}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="sas-confirm-btn"
        disabled={selected === null}
        onClick={onConfirm}
      >
        {selected === null ? t('sasPick') : t('sasConfirm')}
      </button>
      <button type="button" className="hs-textlink" data-testid="sas-nomatch-btn" onClick={() => session.confirmSas(false)}>
        {t('sasNone')}
      </button>
    </Screen>
  );
}
