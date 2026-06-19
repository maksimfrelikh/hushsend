import { useEffect, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink, Waiting, CopyButton } from '../ui';
import { linkToQrSvg } from '../qr';

/**
 * Host view for the qr method (step 5b) while `awaitingPeer`. Identical to the link method — same
 * one-time secret in the same `<origin>/#<roomCode>.<S>` link — but the link is rendered as a QR
 * code for the other device to scan. `credential[0]` is the link; we render it to an SVG QR
 * locally (nothing leaves the device) and also expose the plain URL (copy + e2e/`link-url` mirror).
 */
export function QrCreateScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const link = useAppSelector((s) => s.connection.credential)?.[0] ?? '';
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    let alive = true;
    void linkToQrSvg(link).then((s) => {
      if (alive) setSvg(s);
    });
    return () => {
      alive = false;
    };
  }, [link]);

  return (
    <Screen center>
      <Eyebrow parts={[t('qcrEyebrow')]} />
      <h2 className="hs-h2">{t('qcrTitle')}</h2>
      <p className="hs-sub">{t('qcrDesc')}</p>

      {svg ? (
        // The SVG is generated locally from our own link (only [A-Za-z0-9_-./#:] characters reach
        // it, and the QR draws rectangles, not markup) — no injection surface.
        <div className="hs-qr" data-testid="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="hs-qr hs-qr--loading" aria-hidden="true" />
      )}

      {/* plain link mirror — copy affordance + the string the QR encodes (read by the e2e) */}
      <span className="sr-only" data-testid="link-url">
        {link}
      </span>
      <CopyButton value={link} testId="copy-link-btn" />

      <Waiting label={t('waiting')} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
