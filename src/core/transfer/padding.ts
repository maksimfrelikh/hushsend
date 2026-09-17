/**
 * Volume padding — make the number of bytes on the wire reveal a RANGE, not the exact file size.
 *
 * WHAT LEAKS WITHOUT IT. The contents are unreadable (DTLS end to end) but the VOLUME is not hidden:
 * chunks are 16–256 KiB and the total is ≈ the file size. Anyone who sees the path — a hostile
 * signaling server that placed itself on it, or either side's ISP — reads "4,723,811 bytes in 12 s".
 * When the adversary already has a candidate set of documents, an exact byte count identifies which
 * one, as surely as the filename would. THREATMODEL.md § 4 / road-map item 6.
 *
 * THE LADDER, and the trade it makes, stated rather than buried.
 *
 *   size < 1 MiB  → the next power of two, floor 16 KiB.
 *   size ≥ 1 MiB  → up to the next multiple of an eighth of its leading power of two.
 *
 * So small files — the most identifiable, and the cheapest to hide — collapse into a handful of wide
 * buckets, while large files cost at most 12.5% extra bandwidth. That ceiling is the whole reason the
 * ladder is not powers of two throughout: this product is for people on metered and slow links, and
 * doubling a 1 GB transfer to hide its size is a trade most of them would not take. The cost is
 * resolution: above 1 MiB an observer still learns the size to within 12.5%, which against a SMALL
 * candidate set may still be enough to identify a document. If that matters more than bandwidth,
 * {@link BUCKETS_PER_OCTAVE} is the one constant to change — 1 makes it powers of two.
 *
 * WHAT IT DOES NOT HIDE, so nobody reads more into it than it delivers:
 *  - **Duration and timing.** Padding adds bytes, not time obfuscation; a slow link still shows a
 *    long transfer, and the pause between the offer and the first byte is still visible.
 *  - **That a transfer happened at all**, or between whom (§ 4 — inherent to direct P2P).
 *  - **The number of transfers.** Ten small files sent one by one look like ten transfers whatever
 *    each is padded to. (Sending them together is one zip, hence one padded volume.)
 */

/** Smallest volume we will ever put on the wire: everything below this is indistinguishable. */
export const PAD_FLOOR = 16 * 1024;
/** Where the ladder switches from powers of two to the cheaper fixed-fraction steps. */
export const PAD_COARSE_BELOW = 1024 * 1024;
/** Steps per doubling above {@link PAD_COARSE_BELOW}. 8 ⇒ ≤12.5% overhead; 1 ⇒ powers of two. */
export const BUCKETS_PER_OCTAVE = 8;

/**
 * The total number of payload bytes to put on the wire for a file of `size` bytes.
 *
 * Always ≥ `size`. Monotonic, so a bigger file never pads to a smaller volume — which would leak by
 * inversion. Deterministic: both sides compute it from the same declared size, so no field has to be
 * added to the wire protocol and an old receiver simply sees trailing bytes it discards.
 */
export function paddedSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const n = Math.ceil(size);
  if (n <= PAD_FLOOR) return PAD_FLOOR;
  if (n < PAD_COARSE_BELOW) {
    let p = PAD_FLOOR;
    while (p < n) p *= 2;
    return p;
  }
  // Leading power of two, then round up to the next 1/BUCKETS_PER_OCTAVE of it.
  const octave = 2 ** Math.floor(Math.log2(n));
  const step = Math.max(1, octave / BUCKETS_PER_OCTAVE);
  return Math.ceil(n / step) * step;
}

/** How many filler bytes a file of `size` needs. Zero when it already lands on a bucket edge. */
export function padBytesFor(size: number): number {
  return Math.max(0, paddedSize(size) - Math.max(0, Math.ceil(size || 0)));
}
