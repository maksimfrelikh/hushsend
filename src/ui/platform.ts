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

/** iOS Safari's question before every download, or Safari-on-macOS's once-per-site one. */
export type DownloadPrompt = 'ios' | 'mac';

/**
 * Which of Safari's own download questions follows a received file, if any. Measured on real devices:
 * iOS Safari asks "Download …?" before EVERY download (the iPhone 15 pass, 2026-10-03), and Safari on
 * macOS asks "Allow downloads on this site?" until the site is allowed once (2026-09-28 — that prompt
 * held a finished 2 GiB receive). Until the person answers, the file is not saved, while hushsend
 * already says "Received". Chrome, Firefox and Android Chrome save without a question, so they get
 * null. An iPad asking for the desktop site sends a Macintosh UA; its touch points say it is an iPad.
 * Other iOS browsers (CriOS, FxiOS, …) were not measured and get null rather than a guess.
 */
export function downloadPromptFor(userAgent: string, maxTouchPoints: number): DownloadPrompt | null {
  const safari =
    /Safari\//.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS|Edg\/|OPR\/|Firefox)/.test(userAgent);
  if (!safari) return null;
  if (/(iPhone|iPad|iPod)/.test(userAgent)) return 'ios';
  if (/Macintosh/.test(userAgent)) return maxTouchPoints > 1 ? 'ios' : 'mac';
  return null;
}

/** `downloadPromptFor` for this browser. */
export function downloadPromptHere(): DownloadPrompt | null {
  if (typeof navigator === 'undefined') return null;
  return downloadPromptFor(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}

/** A touch-first device (phone / tablet): the primary pointer is coarse. False where `matchMedia` is absent. */
export function onCoarsePointer(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches;
}
