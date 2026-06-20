import { useMemo, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink } from '../ui';
import { buildSasOptions, sasSelectionOk } from '../sasOptions';

/**
 * Room-method SAS comparison, ASYMMETRIC so the "pick from 3" actually protects against a MITM:
 *
 *  - the **reader** is shown its phrase and reads the three words aloud to its peer;
 *  - the **picker** is BLIND to the phrase and must identify it among three indistinguishable
 *    options by listening to the reader.
 *
 * The room method is a mesh LOBBY, so a pair can be creator↔joiner OR joiner↔joiner — the role can
 * no longer be "creator reads". It is fixed PER PAIR in the core from the two readable ids (smaller
 * id reads; `sasRoleFor`) and projected as `connection.sasRole`. Both sides compute opposite roles,
 * so every pair has exactly one reader + one picker.
 *
 * If the picker could see its own phrase it would just click it without listening, and a MITM
 * (which makes the two sides derive DIFFERENT phrases) would go undetected. By splitting the roles,
 * a MITM is caught: the picker hears the reader's phrase, finds it is NOT among its options (its own
 * derived phrase differs), and picks "none of these" → `confirmSas(false)` → both abort.
 *
 * FAIL CLOSED: if the role is unresolved (`null` — an id was missing) we render the restart screen,
 * NEVER a functional blind picker (a reader-less pair could false-accept a MITM ~1/9).
 *
 * The crypto/protocol are unchanged: the real phrase still comes from the store (`connection.sas`),
 * `sas.ts` is untouched, and both sides still gate on the mutual `sas-confirm{ok}`. `ok=true` is
 * sent only when the picker selects the real phrase (or the reader confirms its peer found it).
 */
export function SasScreen(): ReactElement {
  const sasRole = useAppSelector((s) => s.connection.sasRole);
  if (sasRole === 'reader') return <ReaderView />;
  if (sasRole === 'picker') return <PickerView />;
  return <RestartView />; // null → fail closed (never a functional picker without a reader)
}

/** Fail-closed screen: the per-pair SAS role could not be resolved (a readable id was missing), so
 *  we cannot safely run the asymmetric comparison. Restart rather than silently degrading to a
 *  reader-less picker. Closes the BACKLOG "SAS fail-closed on unset role" item. */
function RestartView(): ReactElement {
  const session = useSession();
  const t = useT();
  return (
    <Screen center>
      <span className="hs-glyph hs-glyph--warn" aria-hidden="true">
        △
      </span>
      <Eyebrow parts={[t('sasRestartEyebrow')]} />
      <h2 className="hs-h2">{t('sasRestartTitle')}</h2>
      <p className="hs-sub" data-testid="sas-restart">
        {t('sasRestartDesc')}
      </p>
      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="sas-restart-btn"
        onClick={() => session.dispose()}
      >
        {t('sasRestartBtn')}
      </button>
    </Screen>
  );
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
