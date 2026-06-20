import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, type Lang, type StrKey } from './i18n';
import { DEFAULT_PRIVACY_MODE, type PrivacyMode } from '../core/iceServers';

/**
 * UI preferences (language + light/dark theme + privacy mode), persisted to localStorage. These are
 * NON-secret display/transport preferences only — they never touch the connection/transfer state and
 * never reach the server. The theme is reflected onto <html data-theme> so the kit's [data-theme]
 * palette applies (see theme.css); language drives the bilingual copy table (i18n.ts). The privacy
 * mode (`max` direct-only / `reliable` relay-allowed) is pushed into the SessionController, which
 * reads it at pairing start to assemble iceServers (see App's <PrivacyModeSync>).
 */
export type Theme = 'light' | 'dark';

interface Prefs {
  lang: Lang;
  theme: Theme;
  /** Privacy mode: `max` = direct-only (default), `reliable` = allow a TURN relay fallback. */
  privacyMode: PrivacyMode;
  setLang(lang: Lang): void;
  toggleTheme(): void;
  setPrivacyMode(mode: PrivacyMode): void;
  /** translate a copy key into the active language. */
  t(key: StrKey): string;
}

const LANG_KEY = 'hushsend.lang';
const THEME_KEY = 'hushsend.theme';
const PRIVACY_KEY = 'hushsend.privacy';

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* localStorage unavailable (private mode / SSR) — use the fallback */
  }
  return fallback;
}

const PrefsContext = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStored(LANG_KEY, ['en', 'ru'] as const, 'en'));
  const [theme, setTheme] = useState<Theme>(() => readStored(THEME_KEY, ['light', 'dark'] as const, 'light'));
  const [privacyMode, setPrivacyModeState] = useState<PrivacyMode>(() =>
    readStored(PRIVACY_KEY, ['max', 'reliable'] as const, DEFAULT_PRIVACY_MODE),
  );

  // Reflect the theme onto <html> so the kit's [data-theme="dark"] palette resolves.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore persistence failure */
    }
  }, [theme]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleTheme = useCallback(() => setTheme((cur) => (cur === 'light' ? 'dark' : 'light')), []);

  const setPrivacyMode = useCallback((next: PrivacyMode) => {
    setPrivacyModeState(next);
    try {
      localStorage.setItem(PRIVACY_KEY, next);
    } catch {
      /* ignore persistence failure (private mode / SSR) */
    }
  }, []);

  const value = useMemo<Prefs>(
    () => ({ lang, theme, privacyMode, setLang, toggleTheme, setPrivacyMode, t: (key) => translate(key, lang) }),
    [lang, theme, privacyMode, setLang, toggleTheme, setPrivacyMode],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used within <PrefsProvider>');
  return ctx;
}

/** Convenience hook for screens that only need the translator. */
export function useT(): (key: StrKey) => string {
  return usePrefs().t;
}
