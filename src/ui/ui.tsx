import { useState, type ReactElement, type ReactNode } from 'react';
import { copyToClipboard } from 'stark-ui-kit';
import { useAppSelector } from '../store/hooks';
import { usePrefs, useT } from './prefs';

/** Uppercase mono eyebrow. `parts` are joined with a dimmed dot separator. */
export function Eyebrow({ parts, testId }: { parts: string[]; testId?: string }): ReactElement {
  return (
    <p className="hs-eyebrow" data-testid={testId}>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className="sep">·</span>}
          {p}
        </span>
      ))}
    </p>
  );
}

/** Quiet "← back" link used at the foot of flow screens. */
export function BackLink({ onClick }: { onClick: () => void }): ReactElement {
  const t = useT();
  return (
    <button type="button" className="hs-textlink" onClick={onClick}>
      {t('back')}
    </button>
  );
}

export function Waiting({ label }: { label: string }): ReactElement {
  return (
    <div className="hs-waiting">
      <span className="hs-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Animated "establishing channel" pulse glyph (lobby / connecting). */
export function PulseGlyph(): ReactElement {
  return (
    <div className="hs-pulse" aria-hidden="true">
      <span className="hs-pulse__ring" />
      <span className="hs-pulse__ring" />
      <span className="hs-pulse__core">↔</span>
    </div>
  );
}

/** Copy-to-clipboard pill using the kit utility; falls back gracefully when unavailable. */
export function CopyButton({ value, testId }: { value: string; testId?: string }): ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" data-testid={testId} onClick={() => void onCopy()}>
      {copied ? t('copied') : t('copy')}
    </button>
  );
}

/**
 * Native "Share" affordance for the invite link (link / qr methods). Uses the Web Share API where
 * present (mobile, mostly) and renders nothing where it isn't — the Copy button already covers
 * desktop, so there is no fallback button to show. The OS share sheet is the only consumer of the
 * value; nothing here touches the network.
 */
export function ShareButton({ value }: { value: string }): ReactElement | null {
  const t = useT();
  if (typeof navigator === 'undefined' || !('share' in navigator)) return null;
  const onShare = (): void => {
    void navigator.share({ url: value }).catch(() => {
      /* user dismissed the share sheet, or it failed — no-op (Copy remains available) */
    });
  };
  return (
    <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" data-testid="share-link-btn" onClick={onShare}>
      {t('share')}
    </button>
  );
}

/**
 * The "Max privacy" toggle from the mockups, rendered DISABLED / coming-soon. The reliable-vs-
 * max-privacy mode (and any TURN relay it would gate) is step 6 — there is intentionally NO
 * transport/ICE behaviour wired behind it here. It is shown so the home composition matches the
 * design, with a clear "soon" affordance and aria-disabled state.
 */
export function PrivacyToggle(): ReactElement {
  const t = useT();
  return (
    <div className="hs-card">
      <div className="hs-toggle">
        <div className="hs-toggle__body">
          <span className="hs-toggle__title">
            {t('privacyTitle')}
            <span className="hs-soon">{t('soon')}</span>
          </span>
          <span className="hs-toggle__desc">{t('privacyDesc')}</span>
        </div>
        <span className="hs-switch" role="switch" aria-checked="false" aria-disabled="true" aria-label={t('privacyTitle')}>
          <span className="hs-switch__knob" />
        </span>
      </div>
    </div>
  );
}

/**
 * An always-rendered, screen-reader-only mirror of the FSM status. It is the single, stable hook
 * the e2e relies on to read the connection state regardless of which screen is showing. Invisible
 * to sighted users; harmless in production.
 */
export function StatusBeacon(): ReactElement {
  const status = useAppSelector((s) => s.connection.status);
  return (
    <span className="sr-only" data-testid="status">
      {status}
    </span>
  );
}

/** Top bar: wordmark + language toggle + light/dark theme toggle. */
export function TopBar(): ReactElement {
  const { lang, setLang, theme, toggleTheme } = usePrefs();
  return (
    <header className="hs-topbar">
      <span className="hs-wordmark">hushsend</span>
      <div className="hs-topbar__right">
        <div className="hs-seg" role="group" aria-label="language">
          <button
            type="button"
            className="hs-seg__btn"
            aria-pressed={lang === 'en'}
            onClick={() => setLang('en')}
          >
            EN
          </button>
          <button
            type="button"
            className="hs-seg__btn"
            aria-pressed={lang === 'ru'}
            onClick={() => setLang('ru')}
          >
            RU
          </button>
        </div>
        <button
          type="button"
          className="hs-icon-btn"
          aria-label={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
          onClick={toggleTheme}
        >
          <span className="hs-theme-glyph" />
        </button>
      </div>
    </header>
  );
}

/** A centred screen scaffold with consistent rhythm. */
export function Screen({
  center,
  wide,
  children,
}: {
  center?: boolean;
  wide?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`hs-screen${center ? ' hs-screen--center' : ''}${wide ? ' hs-screen--wide' : ''}`}>
      {children}
    </section>
  );
}
