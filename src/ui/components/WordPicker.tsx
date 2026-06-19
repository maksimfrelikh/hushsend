import { useMemo, useState, type ReactElement } from 'react';
import { WORDLIST, TOTAL_WORDS } from '../../core/words/words';
import { useT } from '../prefs';

/**
 * B-side word picker for the words / PAKE receive flow. Five positions, in order; each is its OWN
 * autocomplete over the FULL EFF short #2 list — never a "correct + decoys" set (B can't know the
 * answer, and transmitting candidates would leak the entropy to the relay). Typing ≥3 letters
 * narrows to the unique word (the list's unique-3-char-prefix property); the human SELECTS it from
 * the suggestions rather than free-typing. Word 1 is the public rendezvous; words 2–5 are the secret
 * CPace password. On all 5 selected, `onJoin(words)` runs the join.
 *
 * The selection-not-typing contract and the testid surface (word-pos-N / word-input-N /
 * word-picked-N / words-join-btn) are preserved from the original harness so the words e2e is
 * unchanged in substance.
 */
export function WordPicker({ onJoin }: { onJoin: (words: string[]) => void }): ReactElement {
  const t = useT();
  const [query, setQuery] = useState<string[]>(() => Array<string>(TOTAL_WORDS).fill(''));
  const [picked, setPicked] = useState<boolean[]>(() => Array<boolean>(TOTAL_WORDS).fill(false));

  const onType = (i: number, value: string): void => {
    setQuery((q) => q.map((v, j) => (j === i ? value : v)));
    setPicked((p) => p.map((v, j) => (j === i ? false : v))); // editing un-confirms a position
  };
  const onPick = (i: number, word: string): void => {
    setQuery((q) => q.map((v, j) => (j === i ? word : v)));
    setPicked((p) => p.map((v, j) => (j === i ? true : v)));
  };
  const onRemove = (i: number): void => {
    setQuery((q) => q.map((v, j) => (j === i ? '' : v)));
    setPicked((p) => p.map((v, j) => (j === i ? false : v)));
  };

  const count = picked.filter(Boolean).length;
  const allPicked = count === TOTAL_WORDS;
  // The "active" slot (strong border) is the first unfilled position.
  const activeIndex = picked.findIndex((p) => !p);

  return (
    <>
      <p className="hs-meta">
        {count} / {TOTAL_WORDS}
      </p>
      <div className="hs-slots" data-testid="word-picker">
        {Array.from({ length: TOTAL_WORDS }, (_, i) => (
          <WordSlot
            key={i}
            index={i}
            query={query[i]}
            picked={picked[i]}
            active={i === activeIndex}
            placeholder={t('pakePlaceholder')}
            noMatch={t('pakeNoMatch')}
            onType={(v) => onType(i, v)}
            onPick={(w) => onPick(i, w)}
            onRemove={() => onRemove(i)}
          />
        ))}
      </div>
      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="words-join-btn"
        disabled={!allPicked}
        onClick={() => onJoin(query)}
      >
        {t('pakeCta')}
      </button>
    </>
  );
}

function WordSlot({
  index,
  query,
  picked,
  active,
  placeholder,
  noMatch,
  onType,
  onPick,
  onRemove,
}: {
  index: number;
  query: string;
  picked: boolean;
  active: boolean;
  placeholder: string;
  noMatch: string;
  onType: (value: string) => void;
  onPick: (word: string) => void;
  onRemove: () => void;
}): ReactElement {
  const q = query.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (picked || q.length < 3) return []; // need ≥3 chars; a confirmed slot hides its list
    return WORDLIST.filter((w) => w.startsWith(q)).slice(0, 6);
  }, [q, picked]);
  const showNoMatch = !picked && q.length >= 3 && suggestions.length === 0;

  const num = String(index + 1).padStart(2, '0');
  const slotClass = `hs-slot${active ? ' hs-slot--active' : ''}${picked ? ' hs-slot--filled' : ''}`;

  return (
    <div className={slotClass} data-testid={`word-pos-${index}`}>
      <div className="hs-slot__box">
        <span className="hs-slot__num">{num}</span>
        {picked ? (
          <>
            <span className="hs-slot__word" data-testid={`word-picked-${index}`}>
              {query}
            </span>
            <button type="button" className="hs-slot__remove" aria-label="remove word" onClick={onRemove}>
              ×
            </button>
          </>
        ) : (
          <input
            className="hs-slot__input"
            value={query}
            onChange={(e) => onType(e.target.value)}
            placeholder={active ? placeholder : '—'}
            aria-label={`word ${index + 1}`}
            data-testid={`word-input-${index}`}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="hs-suggest" data-testid={`word-suggest-${index}`}>
          {suggestions.map((w) => (
            <button
              key={w}
              type="button"
              className="hs-suggest__btn"
              aria-label={w}
              data-testid={`word-opt-${index}`}
              onClick={() => onPick(w)}
            >
              {w}
            </button>
          ))}
        </div>
      )}
      {showNoMatch && <p className="hs-meta">{noMatch}</p>}
    </div>
  );
}
