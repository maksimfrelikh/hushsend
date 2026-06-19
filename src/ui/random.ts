/**
 * Small CSPRNG helpers for DISPLAY-ONLY randomness (e.g. the SAS decoy phrases in sasOptions.ts and
 * their shuffle). These never produce security material — the real SAS phrase and all credentials
 * come from the core. Using the CSPRNG anyway keeps the codebase free of Math.random and avoids
 * modulo bias.
 */

/** Uniform integer in [0, n) via rejection sampling (no modulo bias). */
export function randBelow(n: number): number {
  if (n <= 0) return 0;
  const limit = Math.floor(0x1_0000 / n) * n;
  const buf = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** A fresh array shuffled with a CSPRNG Fisher–Yates (does not mutate the input). */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
