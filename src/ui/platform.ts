/**
 * A desktop Mac, from the UA string and the touch-point count. iPadOS Safari requests desktop sites
 * with a Macintosh UA too, and no Mac has a multi-touch screen — so more than one touch point is an
 * iPad. Used only to decide whether a hint about a macOS setting is worth showing; nothing is gated
 * on it.
 */
export function isMacDesktop(userAgent: string, maxTouchPoints: number): boolean {
  return /Macintosh/.test(userAgent) && maxTouchPoints <= 1;
}

/** `isMacDesktop` for this browser. */
export function onMacDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isMacDesktop(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}

/** A touch-first device (phone / tablet): the primary pointer is coarse. False where `matchMedia` is absent. */
export function onCoarsePointer(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches;
}
