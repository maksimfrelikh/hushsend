import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Eyebrow, BackLink } from '../ui';
import { parseLink } from '../../core/link/link';

/**
 * QR receive (step 5b): point the camera at the host's QR, decode it to the link, then join exactly
 * as the link method does. The decode uses the `barcode-detector` ponyfill (native `BarcodeDetector`
 * where available, zxing-wasm fallback) over a `getUserMedia` video stream — imported lazily so its
 * WASM never loads unless the user actually scans.
 *
 * Camera denial / absence is handled with a clear, always-present fallback: paste the link instead.
 * That fallback is also the deterministic injection point for the qr e2e (headless cameras can't
 * decode a QR), which fills it with the decoded link and submits — the SAME joinLinkSession path a
 * real scan reaches. The screen lives in the home view state; joining moves the FSM off `idle` and
 * the status-driven router takes over.
 */
export function ScanScreen({ onBack }: { onBack: () => void }): ReactElement {
  const session = useSession();
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [paste, setPaste] = useState('');

  // Join at most once — guard so a camera hit and the paste fallback can't both fire.
  const joinedRef = useRef(false);
  const join = (raw: string): boolean => {
    const parsed = parseLink(raw);
    if (!parsed) return false;
    if (!joinedRef.current) {
      joinedRef.current = true;
      void session.joinLinkSession(parsed.roomCode, parsed.secret, 'qr');
    }
    return true;
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let detector: import('barcode-detector/ponyfill').BarcodeDetector | null = null;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      const video = videoRef.current;
      if (cancelled || !detector || !video) return;
      try {
        const codes = await detector.detect(video);
        for (const c of codes) {
          if (join(c.rawValue)) return; // valid hushsend link → stop scanning (join fires once)
        }
      } catch {
        /* transient per-frame decode error — keep scanning */
      }
      if (!cancelled) raf = requestAnimationFrame(() => void tick());
    };

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch {
        if (!cancelled) setCameraError(true); // denied / no camera → paste fallback
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* autoplay race — the stream is attached, detection still runs */
      }
      try {
        const mod = await import('barcode-detector/ponyfill');
        detector = new mod.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        if (!cancelled) setCameraError(true);
        return;
      }
      raf = requestAnimationFrame(() => void tick());
    };

    void start();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    // Run once on mount; `session` is a stable singleton and `join` closes over stable refs.
  }, []);

  const onPasteSubmit = (): void => {
    if (!join(paste.trim())) setInvalid(true);
  };

  return (
    <Screen center>
      <Eyebrow parts={[t('scanEyebrow')]} />
      <h2 className="hs-h2">{t('scanTitle')}</h2>
      <p className="hs-sub">{t('scanDesc')}</p>

      {!cameraError ? (
        <div className="hs-scan">
          <video ref={videoRef} className="hs-scan__video" muted playsInline data-testid="scan-video" />
          <span className="hs-scan__frame" aria-hidden="true" />
        </div>
      ) : (
        <p className="hs-meta" data-testid="scan-camera-error">
          {t('scanCameraError')}
        </p>
      )}

      <div className="hs-stack">
        <p className="hs-section-label">{t('scanPastePrompt')}</p>
        <div className="hs-join-row">
          <input
            className="hs-input"
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setInvalid(false);
            }}
            placeholder={t('scanPastePlaceholder')}
            aria-label={t('scanPastePrompt')}
            data-testid="scan-paste-input"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="hs-btn hs-btn--ghost"
            data-testid="scan-paste-btn"
            disabled={paste.trim().length === 0}
            onClick={onPasteSubmit}
          >
            {t('scanJoin')}
          </button>
        </div>
        {invalid && (
          <p className="hs-meta" data-testid="scan-invalid">
            {t('scanInvalid')}
          </p>
        )}
      </div>

      <BackLink onClick={onBack} />
    </Screen>
  );
}
