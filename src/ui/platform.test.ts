import { describe, it, expect } from 'vitest';
import { downloadPromptFor, isMacDesktop } from './platform';

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15';
const MAC_FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

describe('isMacDesktop', () => {
  it('is true for desktop Chrome, Safari and Firefox on a Mac', () => {
    for (const ua of [MAC_CHROME, MAC_SAFARI, MAC_FIREFOX]) expect(isMacDesktop(ua, 0)).toBe(true);
  });

  it('is false for an iPad asking for the desktop site (a Macintosh UA with touch points)', () => {
    expect(isMacDesktop(MAC_SAFARI, 5)).toBe(false);
  });

  it('is false off the Mac', () => {
    expect(isMacDesktop(IPHONE, 5)).toBe(false);
    expect(isMacDesktop(WINDOWS, 0)).toBe(false);
  });
});

const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36';
const LINUX_WEBKIT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15';

describe('downloadPromptFor', () => {
  it('names the question iOS Safari asks before every download', () => {
    expect(downloadPromptFor(IPHONE, 5)).toBe('ios');
  });

  it('names the once-per-site question of Safari on macOS', () => {
    expect(downloadPromptFor(MAC_SAFARI, 0)).toBe('mac');
  });

  it('treats an iPad asking for the desktop site as iOS', () => {
    expect(downloadPromptFor(MAC_SAFARI, 5)).toBe('ios');
  });

  it('is null where the browser saves without asking, or was not measured', () => {
    for (const ua of [MAC_CHROME, MAC_FIREFOX, WINDOWS, ANDROID_CHROME, IPHONE_CHROME, LINUX_WEBKIT]) {
      expect(downloadPromptFor(ua, 0)).toBeNull();
    }
  });
});
