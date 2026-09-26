import { useMemo, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, Grow, Pill, TextLink } from '../ui';
import { buildSasOptions, sasSelectionOk } from '../sasOptions';
import { FailureLayout } from './FailedScreen';

/**
 * Room-method SAS comparison, ASYMMETRIC so the "pick from 3" actually protects against a MITM:
 *
 *  - the **reader** is shown its phrase — the largest text in the app — and reads the three words
 *    aloud to its peer;
 *  - the **picker** is BLIND to the phrase and must identify it among three indistinguishable
 *    options by listening to the reader.
 *
 * The room method is a mesh LOBBY, so a pair can be creator↔joiner OR joiner↔joiner — the role is
 * fixed PER PAIR in the core (`sasRoleFor`) and projected as `connection.sasRole`. Both sides compute
 * opposite roles, so every pair has exactly one reader + one picker.
 *
 * If the picker could see its own phrase it would just click it without listening, and a MITM
 * (which makes the two sides derive DIFFERENT phrases) would go undetected. By splitting the roles,
 * a MITM is caught: the picker hears the reader's phrase, finds it is NOT among its options (its own
 * derived phrase differs), and picks "none of these" → `confirmSas(false)` → both abort.
 *
 * FAIL CLOSED: if the role is unresolved (`null` — an id was missing) we render the "verification
 * interrupted" failure with Restart verification, NEVER a functional blind picker (a reader-less
 * pair could false-accept a MITM ~1/9).
 */
export function SasScreen(): ReactElement {
  const sasRole = useAppSelector((s) => s.connection.sasRole);
  if (sasRole === 'reader') return <ReaderView />;
  if (sasRole === 'picker') return <PickerView />;
  return <RestartView />; // null → fail closed (never a functional picker without a reader)
}

/** Fail-closed: the per-pair SAS role could not be resolved (a readable id was missing), so the
 *  asymmetric comparison cannot run safely. One of the Failed screen's variants. */
function RestartView(): ReactElement {
  const session = useSession();
  const t = useT();
  return (
    <FailureLayout
      kicker={t('sasRestartEyebrow')}
      title={t('sasRestartTitle')}
      desc={t('sasRestartDesc')}
      descTestId="sas-restart"
      actions={
        <Pill variant="primary" block testId="sas-restart-btn" onClick={() => session.dispose()}>
          {t('sasRestartBtn')}
        </Pill>
      }
    />
  );
}

/** Reader: shown the real phrase to read aloud. NOT a picker — it cannot be tricked into picking, it
 *  only reads + confirms (and stops if the peer reports no match). The sentence directly above the
 *  confirm button is the only gate on this side. */
function ReaderView(): ReactElement {
  const session = useSession();
  const t = useT();
  const real = useAppSelector((s) => s.connection.sas) ?? '';
  const words = real.split(' ').filter(Boolean);

  return (
    <Screen>
      <h2 className="hs-h2">{t('sasReaderTitle')}</h2>
      <Space h={32} />
      <p className="hs-phrase" data-testid="sas-words">
        {words.map((w, i) => (
          <span key={i}>
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </p>
      <Space h={28} />
      <p className="hs-p">{t('sasReaderWarn')}</p>
      <Grow />
      <Space h={28} />
      <Pill
        variant="primary"
        block
        testId="sas-reader-confirm"
        onClick={() => session.confirmSas(true)}
      >
        {t('sasReaderConfirm')}
      </Pill>
      <Space h={4} />
      <TextLink testId="sas-reader-abort" onClick={() => session.confirmSas(false)}>
        {t('sasReaderAbort')}
      </TextLink>
    </Screen>
  );
}

/** Picker: BLIND. The real phrase is NEVER shown on its own — only as one of three indistinguishable
 *  cards (buttons with aria-pressed; selected = ink inversion). */
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
    <Screen>
      <h2 className="hs-h2">{t('sasTitle')}</h2>
      <Space h={28} />
      <div role="group" aria-label={t('sasGroupAria')} className="hs-cards">
        {options.map((phrase, i) => (
          <button
            key={i}
            type="button"
            className="hs-card"
            aria-pressed={selected === i}
            data-testid={`sas-option-${i}`}
            onClick={() => setSelected(i)}
          >
            {phrase}
          </button>
        ))}
      </div>
      <Grow />
      <Space h={28} />
      <Pill
        variant="primary"
        block
        testId="sas-confirm-btn"
        disabled={selected === null}
        onClick={onConfirm}
      >
        {t('sasConfirm')}
      </Pill>
      <Space h={4} />
      <TextLink testId="sas-nomatch-btn" onClick={() => session.confirmSas(false)}>
        {t('sasNone')}
      </TextLink>
    </Screen>
  );
}
