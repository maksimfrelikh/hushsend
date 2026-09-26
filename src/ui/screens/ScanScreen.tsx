import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { Screen, Space, Grow, Pill, BackLink, AlertLine } from '../ui';
import { parseLink } from '../../core/link/link';
import { createQrDetector } from '../zxingWasm';

/**
 * QR receive (step 5b): point the camera at the host's QR, decode it to the link, then join exactly
 * as the link method does. The decode uses the `barcode-detector` ponyfill (native `BarcodeDetector`
 * where available, SELF-HOSTED zxing-wasm fallback — see `zxingWasm.ts`) over a `getUserMedia` video
 * stream — imported lazily so its WASM never loads unless the user actually scans.
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
  const [streaming, setStreaming] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [paste, setPaste] = useState('');

  // Join at most once — guard so a camera hit and the paste fallback can't both fire.
  const joinedRef = useRef(false);
  const join = (raw: string): boolean => {
    const parsed = parseLink(raw);
    if (!parsed) return false;
    if (!joinedRef.current) {
      joinedRef.current = true;
      void session.joinLinkSession(parsed.rendezvous, parsed.secret, 'qr');
    }
    return true;
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let detector: Awaited<ReturnType<typeof createQrDetector>> | null = null;
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
      // Feature-detect the camera API up front: it is undefined on browsers / insecure (non-HTTPS,
      // non-localhost) contexts where getUserMedia simply isn't exposed. Bail straight to the paste
      // fallback rather than throwing on the property access.
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) setCameraError(true);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
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
        if (!cancelled) setStreaming(true);
      } catch {
        /* autoplay race — the stream is attached, detection still runs */
      }
      try {
        detector = await createQrDetector();
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
    <Screen>
      <h2 className="hs-h2">{t('scanTitle')}</h2>
      <Space h={24} />
      <div className={`hs-viewfinder${cameraError ? ' hs-viewfinder--off' : ''}`}>
        {!cameraError && (
          <video
            ref={videoRef}
            className="hs-viewfinder__video"
            muted
            playsInline
            aria-label={t('scanViewfinderAria')}
            data-testid="scan-video"
          />
        )}
        {cameraError ? (
          <p className="hs-viewfinder__hint" data-testid="scan-camera-error">
            {t('scanCameraError')}
          </p>
        ) : (
          !streaming && <p className="hs-viewfinder__hint">{t('scanViewfinder')}</p>
        )}
      </div>
      <Space h={28} />
      <h3 className="hs-h3">{t('scanPasteTitle')}</h3>
      <Space h={12} />
      <form
        className="hs-form-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (paste.trim()) onPasteSubmit();
        }}
      >
        <input
          className="hs-input"
          type="url"
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            setInvalid(false);
          }}
          placeholder={t('scanPastePlaceholder')}
          aria-label={t('scanPasteAria')}
          aria-invalid={invalid || undefined}
          data-testid="scan-paste-input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {invalid && <AlertLine testId="scan-invalid">{t('scanInvalid')}</AlertLine>}
        <Pill
          block
          testId="scan-paste-btn"
          disabled={paste.trim().length === 0}
          onClick={onPasteSubmit}
        >
          {t('scanJoin')}
        </Pill>
      </form>
      <Grow />
      <Space h={20} />
      <BackLink onClick={onBack} />
    </Screen>
  );
}
