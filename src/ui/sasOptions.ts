import { WORDLIST } from '../core/words/words';
import { randBelow, shuffle } from './random';

/**
 * SAS "pick from 3 phrases" option logic — PURE, DISPLAY-ONLY, and unit-tested (sasOptions.test.ts).
 *
 * The real SAS phrase comes from the core (sas.ts — UNCHANGED); this module only builds the human
 * comparison UI: it pads the real phrase with two locally-generated decoys and scores the human's
 * pick. The decoys never leave the device and carry NO entropy claim — security is the full real
 * phrase matching the peer's. Keeping this out of the React component makes the invariants testable
 * without a DOM: decoys are 3 words from the SAME EFF short #2 list, distinct from the real phrase
 * and from each other; the real phrase's position is randomised; and ok=true requires picking the
 * real phrase.
 */

/** SAS is a 3-word phrase (must match the count sas.ts renders). */
export const SAS_WORDS = 3;

/** A random `count`-word phrase from the EFF short #2 list (decoy display use only). */
function randomPhrase(count: number): string {
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(WORDLIST[randBelow(WORDLIST.length)]);
  return words.join(' ');
}

/**
 * Build the 3 SAS option phrases: the REAL phrase plus two locally-generated decoys, shuffled so
 * the real phrase has no fixed position. The decoys are guaranteed distinct from the real phrase
 * and from each other, drawn from the same wordlist and in the same 3-word format, so the three
 * options are indistinguishable to an attacker watching the screen.
 */
export function buildSasOptions(realPhrase: string, wordsPerPhrase: number = SAS_WORDS): string[] {
  const taken = new Set<string>([realPhrase]);
  const decoys: string[] = [];
  // Bounded attempts so a (vanishingly unlikely) run of collisions can't spin forever.
  for (let guard = 0; decoys.length < 2 && guard < 64; guard++) {
    const phrase = randomPhrase(wordsPerPhrase);
    if (!taken.has(phrase)) {
      taken.add(phrase);
      decoys.push(phrase);
    }
  }
  return shuffle([realPhrase, ...decoys]);
}

/**
 * Score a human's pick: true ONLY when the selected option is exactly the real phrase. A null
 * selection ("none of these match", or nothing chosen yet) or an out-of-range index → false. This
 * is the single source of truth for the `confirmSas(ok)` boolean.
 */
export function sasSelectionOk(options: readonly string[], selectedIndex: number | null, realPhrase: string): boolean {
  if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= options.length) return false;
  return options[selectedIndex] === realPhrase;
}
