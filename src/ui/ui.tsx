import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { copyToClipboard } from 'stark-ui-kit';
import { useAppSelector } from '../store/hooks';
import { usePrefs, useT } from './prefs';

/* ------------------------------------------------------------------------------------------------
 * Primitives shared by the screens. Composition, hierarchy and states come from the Claude Design
 * canvas (CLAUDE.md § UI / styling); every colour / font / radius / motion value comes from the kit
 * tokens through app.css. Behaviour (aria, keyboard, state) lives here, in the host, never in the kit.
 * ---------------------------------------------------------------------------------------------- */

/** The stroke glyphs the boards use. One 24-box, currentColor, 1.5 stroke. Decorative unless a
 *  parent gives them meaning, so always aria-hidden. */
export type GlyphName =
  | 'alert'
  | 'warn'
  | 'chevron'
  | 'arrow'
  | 'copy'
  | 'check'
  | 'x'
  | 'paperclip';

const GLYPH_PATHS: Record<GlyphName, ReactElement> = {
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.3v.2" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5 2.5 20h19L12 3.5z" />
      <path d="M12 9.5v5" />
      <path d="M12 17.3v.2" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  paperclip: (
    <path d="M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8" />
  ),
};

export function Glyph({
  name,
  size = 18,
  className,
}: {
  name: GlyphName;
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {GLYPH_PATHS[name]}
    </svg>
  );
}

/** Vertical rhythm exactly as the boards space it: an explicit spacer, not margins that collapse. */
export function Space({ h }: { h: number }): ReactElement {
  return <div className="hs-space" style={{ height: h }} aria-hidden="true" />;
}

/** Pushes what follows to the bottom of the screen column. */
export function Grow(): ReactElement {
  return <div className="hs-grow" aria-hidden="true" />;
}

type PillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'sm';
  block?: boolean;
  testId?: string;
};

/**
 * The lozenge control. Built on the kit's `.pill` (stark-ui-kit/controls.css — border, the ink
 * inversion on hover / press) with the app's geometry on top (`.hs-pill`). `primary` is already ink,
 * `secondary` is the quiet one on the wash.
 */
export function Pill({
  variant = 'secondary',
  size = 'md',
  block,
  testId,
  className,
  children,
  ...rest
}: PillProps): ReactElement {
  const cls = [
    'pill',
    'hs-pill',
    variant === 'primary' && 'hs-pill--primary',
    size === 'sm' && 'hs-pill--sm',
    block && 'hs-pill--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} data-testid={testId} {...rest}>
      {children}
    </button>
  );
}

/** Tertiary action: the uppercase tracked label (back · stop · close channel), 44px tall. */
export function TextLink({
  onClick,
  children,
  testId,
  align = 'center',
}: {
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  align?: 'center' | 'start';
}): ReactElement {
  return (
    <button
      type="button"
      className={`hs-tlink${align === 'start' ? ' hs-tlink--start' : ''}`}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Quiet "Back" at the foot of a flow screen. */
export function BackLink({ onClick }: { onClick: () => void }): ReactElement {
  const t = useT();
  return <TextLink onClick={onClick}>{t('back')}</TextLink>;
}

/** 44 × 44 hit area around a 20px glyph (copy · remove · cancel). The label IS the accessible name. */
export function IconButton({
  glyph,
  label,
  onClick,
  testId,
  className,
}: {
  glyph: GlyphName;
  label: string;
  onClick: () => void;
  testId?: string;
  className?: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={`hs-iconbtn${className ? ` ${className}` : ''}`}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
    >
      <Glyph name={glyph} size={20} />
    </button>
  );
}

/** Error / notice line: alert glyph + words, both in the foreground ink (no colour to spend). */
export function AlertLine({
  children,
  testId,
  live = true,
}: {
  children: ReactNode;
  testId?: string;
  live?: boolean;
}): ReactElement {
  return (
    <p className="hs-alert" role={live ? 'alert' : undefined} data-testid={testId}>
      <Glyph name="alert" size={18} className="hs-alert__glyph" />
      <span>{children}</span>
    </p>
  );
}

/** A collapsible "About" item: native details/summary, chevron drawn by us (no marker). */
export function Collapsible({
  title,
  children,
  testId,
  defaultOpen,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}): ReactElement {
  return (
    <details className="hs-fold" data-testid={testId} open={defaultOpen}>
      <summary className="hs-fold__summary">
        <span className="hs-fold__title">{title}</span>
        <Glyph name="chevron" size={18} className="hs-fold__chevron" />
      </summary>
      <div className="hs-fold__body">{children}</div>
    </details>
  );
}

/**
 * A disclosure row (the transfer path-status rows): a button with aria-expanded and the hint panel
 * under it. `tone` is the whole difference between the everyday "could not check" and the one
 * positive detection: muted words alone, or foreground words with the alert glyph.
 */
export function Disclosure({
  title,
  tone,
  children,
  testId,
  panelTestId,
  attrs,
}: {
  title: string;
  tone: 'muted' | 'alert';
  children: ReactNode;
  testId?: string;
  panelTestId?: string;
  attrs?: Record<string, string>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`hs-disc hs-disc--${tone}`}>
      <button
        type="button"
        className="hs-disc__btn"
        aria-expanded={open}
        aria-controls={id}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        {...attrs}
      >
        {tone === 'alert' && <Glyph name="alert" size={18} />}
        <span className="hs-disc__title">{title}</span>
        <Glyph name="chevron" size={18} className="hs-disc__chevron" />
      </button>
      <div id={id} className="hs-disc__panel" hidden={!open}>
        <p className="hs-p hs-p--muted hs-disc__hint" data-testid={panelTestId}>
          {children}
        </p>
      </div>
    </div>
  );
}

/** Two dots meeting — the only motion in the connecting / reconnect-wait states. Reduced motion
 *  shows them resting in contact (app.css). */
export function MeetDots(): ReactElement {
  return (
    <div className="hs-meet" aria-hidden="true">
      <span className="hs-meet__dot hs-meet__dot--l" />
      <span className="hs-meet__dot hs-meet__dot--r" />
    </div>
  );
}

/**
 * Copy-to-clipboard pill using the kit utility. The label swaps to "Copied" for 1.4 s and the glyph
 * flips ⧉ → ✓; nothing else moves. Falls back silently when the clipboard is unavailable.
 */
export function CopyPill({
  value,
  label,
  testId,
  variant = 'secondary',
  className,
}: {
  value: string;
  label: string;
  testId?: string;
  variant?: 'primary' | 'secondary';
  className?: string;
}): ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const onCopy = async (): Promise<void> => {
    if (await copyToClipboard(value)) setCopied(true);
  };
  return (
    <Pill
      variant={variant}
      testId={testId}
      className={className}
      onClick={() => void onCopy()}
      aria-live="polite"
    >
      <span className={`hs-flip${copied ? ' hs-flip--on' : ''}`}>
        <Glyph name={copied ? 'check' : 'copy'} size={16} />
      </span>
      {copied ? t('copied') : label}
    </Pill>
  );
}

/**
 * Native "Share" for the invite link. Uses the Web Share API where present (phones, mostly) and
 * renders nothing where it isn't — Copy already covers desktop. The OS share sheet is the only
 * consumer of the value; nothing here touches the network.
 */
export function SharePill({ value }: { value: string }): ReactElement | null {
  const t = useT();
  if (typeof navigator === 'undefined' || !('share' in navigator)) return null;
  const onShare = (): void => {
    void navigator.share({ url: value }).catch(() => {
      /* dismissed or failed — Copy remains available */
    });
  };
  return (
    <Pill testId="share-link-btn" className="hs-pill--half" onClick={onShare}>
      {t('share')}
    </Pill>
  );
}

/**
 * An always-rendered, screen-reader-only mirror of the FSM status. It is the single, stable hook
 * the e2e relies on to read the connection state regardless of which screen is showing.
 */
export function StatusBeacon(): ReactElement {
  const status = useAppSelector((s) => s.connection.status);
  return (
    <span className="sr-only" data-testid="status">
      {status}
    </span>
  );
}

/**
 * Brand wordmark — "hush" solid, "send" fading out. `fill="currentColor"` so it follows the
 * monochrome theme; colour comes from `.hs-wordmark` (var(--fg)).
 */
export function Wordmark(): ReactElement {
  return (
    <svg className="hs-wordmark" viewBox="0 0 766 198" role="img" aria-label="hushsend">
      <defs>
        <filter id="hs-wm-b1" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.8" />
        </filter>
        <filter id="hs-wm-b2" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="hs-wm-b3" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7.5" />
        </filter>
        <filter id="hs-wm-b4" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="11.5" />
        </filter>
      </defs>
      <g
        fontFamily="Archivo Variable, Archivo, Arial, sans-serif"
        fontWeight="600"
        fontSize="160"
        fill="currentColor"
      >
        <text x="40" y="156">
          h
        </text>
        <text x="127.85" y="156">
          u
        </text>
        <text x="215.53" y="156">
          s
        </text>
        <text x="296.5" y="156">
          h
        </text>
        <text x="384.35" y="156" opacity="0.85" filter="url(#hs-wm-b1)">
          s
        </text>
        <text x="465.31" y="156" opacity="0.62" filter="url(#hs-wm-b2)">
          e
        </text>
        <text x="549.48" y="156" opacity="0.4" filter="url(#hs-wm-b3)">
          n
        </text>
        <text x="637.33" y="156" opacity="0.22" filter="url(#hs-wm-b4)">
          d
        </text>
      </g>
    </svg>
  );
}

/**
 * Top bar: wordmark + the kit's theme toggle (stark-ui-kit/theme-toggle.css — the half-filled circle
 * that rotates 180° where LIGHT is active; app.css sets `--theme-toggle-flip` on `[data-theme="light"]`).
 * aria-pressed mirrors "the light theme is active", as the kit's contract asks. The EN|RU switch is
 * hidden until the Russian copy is complete (i18n.ts).
 */
export function TopBar(): ReactElement {
  const { theme, toggleTheme } = usePrefs();
  const t = useT();
  return (
    <header className="hs-topbar">
      <Wordmark />
      <div className="hs-topbar__right">
        <button
          type="button"
          className="theme-toggle"
          aria-label={t('themeToggle')}
          aria-pressed={theme === 'light'}
          onClick={toggleTheme}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 1.6 A6.4 6.4 0 0 1 8 14.4 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  );
}

/** A screen: the single column. `center` stacks everything in the middle of the viewport (the
 *  connecting / failed family). */
export function Screen({
  center,
  children,
  testId,
}: {
  center?: boolean;
  children: ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <section className={`hs-screen${center ? ' hs-screen--center' : ''}`} data-testid={testId}>
      {children}
    </section>
  );
}

/** The mono kicker above a failure title ("direct connection failed"). A label, not a heading. */
export function Kicker({ children }: { children: ReactNode }): ReactElement {
  return <span className="hs-kicker">{children}</span>;
}
