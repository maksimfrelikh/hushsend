import { useEffect, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { useT } from '../prefs';
import { Screen, Space, Grow, BackLink, CopyPill, SharePill } from '../ui';
import { linkToQrSvg } from '../qr';

/**
 * Host view for the link / qr method while `awaitingPeer` — ONE screen: the QR, the link under it,
 * Copy and Share. The link is `<origin>/#<token>.<S>`: the rendezvous is a high-entropy 128-bit token
 * (unguessable, so strangers can't reach the room) and the part after `#` carries the secret S,
 * which never reaches the server (browsers don't send the fragment) and which the joiner scrubs
 * from its address bar after reading. Single-use — one connection per link. Waiting for the peer
 * is implied; there is no waiting copy.
 *
 * `credential[0]` is the full link (the core builds it from the allocated token + S). The QR is
 * rendered locally to an SVG (nothing leaves the device); the plain URL is visible and is also the
 * `link-url` mirror the e2e reads.
 */
export function ShareScreen(): ReactElement {
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
    <Screen>
      <h2 className="hs-h2">{t('shareTitle')}</h2>
      <Space h={24} />
      {svg ? (
        // The SVG is generated locally from our own link (only [A-Za-z0-9_-./#:] characters reach
        // it, and the QR draws rectangles, not markup) — no injection surface.
        <div
          className="hs-qr"
          role="img"
          aria-label={t('qrAlt')}
          data-testid="qr-svg"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="hs-qr hs-qr--loading" aria-hidden="true" />
      )}
      <Space h={16} />
      <p className="hs-link" data-testid="link-url">
        {link}
      </p>
      <Space h={20} />
      <div className="hs-pill-row">
        <CopyPill
          value={link}
          label={t('copyLink')}
          variant="primary"
          testId="copy-link-btn"
          className="hs-pill--half"
        />
        <SharePill value={link} />
      </div>
      <Grow />
      <Space h={20} />
      <BackLink onClick={() => session.dispose()} />
    </Screen>
  );
}
