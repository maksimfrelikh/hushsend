/**
 * "Words" credential for the words method.
 *
 * EFF large wordlist (7776 words). A credential is TOTAL_WORDS words:
 * RENDEZVOUS_WORDS rendezvous word(s) — the room id, PUBLIC routing, NOT secret —
 * plus SECRET_WORDS secret words — the CPace password (~39 bits at 3 words).
 * Generated with a CSPRNG, never user-chosen.
 *
 * Load the real 7776-word list into WORDLIST (e.g. a bundled JSON). It is
 * intentionally not inlined here.
 */
export const RENDEZVOUS_WORDS = 1;
export const SECRET_WORDS = 3;
export const TOTAL_WORDS = RENDEZVOUS_WORDS + SECRET_WORDS;

export const WORDLIST: readonly string[] = [
  /* TODO: EFF large wordlist (7776 words) */
];

export function generateWords(): string[] {
  // TODO: TOTAL_WORDS uniform picks from WORDLIST using crypto.getRandomValues,
  //       with rejection sampling to avoid modulo bias.
  throw new Error('generateWords not implemented');
}

/** Split a credential into the public rendezvous (room id) and the secret words. */
export function splitWords(words: string[]): { rendezvous: string; secret: string[] } {
  return {
    rendezvous: words.slice(0, RENDEZVOUS_WORDS).join('-'),
    secret: words.slice(RENDEZVOUS_WORDS),
  };
}
