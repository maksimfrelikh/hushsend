import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { WORDLIST, TOTAL_WORDS } from '../../core/words/words';
import { useT } from '../prefs';
import { Space, Grow, Pill, BackLink, AlertLine } from '../ui';

/**
 * Joiner side of the words / PAKE receive flow: five fields, in order. Each is its OWN autocomplete
 * over the FULL EFF short #2 list — never a "correct + decoys" set (the joiner can't know the answer,
 * and transmitting candidates would leak the entropy to the relay). The list has unique 3-character
 * prefixes, so three letters always narrow to one word.
 *
 * Two completion paths, chosen by the input device (Checks board § 9):
 *  - pointer: inline completion — the rest of the first prefix match is drawn in --faint after the
 *    typed letters; Enter or Tab accepts it (Enter also moves to the next field);
 *  - touch: a listbox of up to three prefix matches under the active field (role=listbox/option,
 *    aria-activedescendant from the field; arrows move, Enter or a tap accepts).
 * "No matching word" appears directly under the field whose letters match nothing. Connect enables
 * once all five fields hold list words; `onJoin(words)` runs the join. Word 1 is the public
 * rendezvous; words 2–5 are the secret CPace password.
 *
 * testid surface: word-pos-N (the field wrapper), word-input-N, word-suggest-N (the listbox),
 * word-opt-N (each option), words-join-btn.
 */
export function WordPicker({
  onJoin,
  onBack,
}: {
  onJoin: (words: string[]) => void;
  onBack: () => void;
}): ReactElement {
  const t = useT();
  const touch = useTouchMode();
  const [values, setValues] = useState<string[]>(() => Array<string>(TOTAL_WORDS).fill(''));
  const [active, setActive] = useState<number | null>(null);
  const [activeOpt, setActiveOpt] = useState(0);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const normalized = values.map((v) => v.trim().toLowerCase());
  const valid = normalized.map((q) => q.length > 0 && WORDLIST.includes(q));
  const allValid = valid.every(Boolean);

  const setValue = (i: number, v: string): void => {
    setValues((vals) => vals.map((x, j) => (j === i ? v : x)));
    setActiveOpt(0);
  };
  const accept = (i: number, word: string, advance: boolean): void => {
    setValue(i, word);
    if (advance) inputs.current[i + 1]?.focus();
  };

  return (
    <>
      <div className="hs-fields">
        {Array.from({ length: TOTAL_WORDS }, (_, i) => (
          <WordField
            key={i}
            index={i}
            value={values[i]}
            valid={valid[i]}
            active={active === i}
            activeOpt={activeOpt}
            touch={touch}
            inputRef={(el) => {
              inputs.current[i] = el;
            }}
            onChange={(v) => setValue(i, v)}
            onFocus={() => {
              setActive(i);
              setActiveOpt(0);
            }}
            onBlur={() => setActive((a) => (a === i ? null : a))}
            onMoveOpt={(d, n) => setActiveOpt((o) => Math.min(Math.max(o + d, 0), n - 1))}
            onAccept={(word, advance) => accept(i, word, advance)}
          />
        ))}
      </div>
      <Grow />
      <Space h={24} />
      <Pill
        variant="primary"
        block
        testId="words-join-btn"
        disabled={!allValid}
        onClick={() => onJoin(normalized)}
      >
        {t('pakeCta')}
      </Pill>
      <Space h={4} />
      <BackLink onClick={onBack} />
    </>
  );
}

/** Touch (coarse pointer / no hover) vs pointer, decided once per mount from the media queries. */
function useTouchMode(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(hover: none), (pointer: coarse)');
    setTouch(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => setTouch(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return touch;
}

function WordField({
  index,
  value,
  valid,
  active,
  activeOpt,
  touch,
  inputRef,
  onChange,
  onFocus,
  onBlur,
  onMoveOpt,
  onAccept,
}: {
  index: number;
  value: string;
  valid: boolean;
  active: boolean;
  activeOpt: number;
  touch: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onChange: (v: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onMoveOpt: (delta: number, count: number) => void;
  onAccept: (word: string, advance: boolean) => void;
}): ReactElement {
  const t = useT();
  const listId = useId();
  const q = value.trim().toLowerCase();
  // Suggestions start at two letters (one letter would list an arbitrary three of many).
  const matches = useMemo(
    () => (q.length >= 2 ? WORDLIST.filter((w) => w.startsWith(q)).slice(0, 3) : []),
    [q],
  );
  const completion = !valid && matches.length > 0 ? matches[0] : null;
  const noMatch = q.length >= 2 && matches.length === 0;
  const listOpen = touch && active && !valid && matches.length > 0;
  const selected = Math.min(activeOpt, Math.max(matches.length - 1, 0));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (completion) {
        const word = touch ? matches[selected] : matches[0];
        onAccept(word, e.key === 'Enter');
        if (e.key === 'Enter') e.preventDefault();
        // Tab: accept and let focus move on its own.
      } else if (e.key === 'Enter' && valid) {
        e.preventDefault();
        onAccept(q, true);
      }
      return;
    }
    if (touch && listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      onMoveOpt(e.key === 'ArrowDown' ? 1 : -1, matches.length);
    }
  };

  return (
    <div className="hs-field" data-testid={`word-pos-${index}`}>
      <input
        ref={inputRef}
        className="hs-input hs-field__input"
        type="text"
        value={value}
        placeholder={`${t('wordPlaceholder')} ${index + 1}`}
        aria-label={`${t('wordPlaceholder')} ${index + 1}`}
        aria-invalid={noMatch || undefined}
        role={touch ? 'combobox' : undefined}
        aria-autocomplete={touch ? 'list' : 'inline'}
        aria-expanded={touch ? listOpen : undefined}
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen ? `${listId}-${selected}` : undefined}
        data-testid={`word-input-${index}`}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {!touch && active && completion && (
        <span className="hs-field__ghost" aria-hidden="true">
          <span className="hs-field__ghost-typed">{value}</span>
          <span className="hs-field__ghost-rest">{completion.slice(q.length)}</span>
        </span>
      )}
      {listOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('suggestionsAria')}
          className="hs-listbox"
          data-testid={`word-suggest-${index}`}
        >
          {matches.map((w, i) => (
            <div
              key={w}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === selected}
              className="hs-option"
              data-testid={`word-opt-${index}`}
              // mousedown, so the field does not blur (and close the list) before the tap lands
              onMouseDown={(e) => {
                e.preventDefault();
                onAccept(w, true);
              }}
            >
              {w}
            </div>
          ))}
        </div>
      )}
      {noMatch && active && (
        <>
          <Space h={8} />
          <AlertLine>{t('pakeNoMatch')}</AlertLine>
        </>
      )}
    </div>
  );
}
