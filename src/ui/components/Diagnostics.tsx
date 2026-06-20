import { type ReactElement } from 'react';
import { useAppSelector } from '../../store/hooks';

/**
 * DEV-only diagnostics strip. Surfaces the non-secret projections that are useful for
 * development and for the e2e to observe (own identity pubkey, the pinned peer, DTLS
 * fingerprints, and the signaling activity log — e.g. the "word-room TTL expired" note).
 *
 * It renders ONLY under `import.meta.env.DEV`, so it is dead-code-eliminated from production
 * builds — the shipped app shows the designed screens alone. None of these values are secret:
 * public keys, a pairing identifier, and public DTLS fingerprints.
 */
export function Diagnostics(): ReactElement | null {
  const dev = useAppSelector((s) => s.dev);
  const relax = useAppSelector((s) => s.connection.relax);
  if (!import.meta.env.DEV) return null;

  return (
    <aside className="hs-diag" aria-label="developer diagnostics">
      <p className="hs-diag__label">diagnostics (dev)</p>
      <p>
        self: <span data-testid="self-id">{dev.selfId ?? '—'}</span>
      </p>
      <p>
        you: <span data-testid="own-pubkey">{dev.ownPublicKey ?? '—'}</span>
      </p>
      {dev.pinnedPeer ? (
        <>
          <p>
            pinned pairingId: <span data-testid="pinned-peer-id">{dev.pinnedPeer.pairingId}</span>
          </p>
          <p>
            pinned peer key: <span data-testid="pinned-peer-pubkey">{dev.pinnedPeer.peerPublicKey}</span>
          </p>
        </>
      ) : (
        <p>no peer pinned this session</p>
      )}
      <p>local fp: {dev.localFingerprint ?? '—'}</p>
      <p>remote fp: {dev.remoteFingerprint ?? '—'}</p>
      <p>
        ice mode: <span data-testid="ice-mode">{dev.iceConfig?.mode ?? '—'}</span> · relay:{' '}
        <span data-testid="ice-relay">{dev.iceConfig ? String(dev.iceConfig.relay) : '—'}</span>
      </p>
      <p>
        turn urls: <span data-testid="ice-turn-urls">{dev.iceConfig?.urls.join(',') ?? '—'}</span>
      </p>
      <p>
        turn user: <span data-testid="ice-turn-username">{dev.iceConfig?.username ?? '—'}</span> · cred:{' '}
        <span data-testid="ice-turn-credential">{dev.iceConfig?.credential ?? '—'}</span>
      </p>
      <p>
        relax: avail <span data-testid="relax-available">{String(relax.available)}</span> · local{' '}
        <span data-testid="relax-local">{String(relax.localRelaxed)}</span> · peer{' '}
        <span data-testid="relax-peer">{String(relax.peerRelaxed)}</span>
      </p>
      {dev.log.length > 0 && (
        <ul>
          {dev.log.map((entry, i) => (
            <li key={i}>{entry}</li>
          ))}
        </ul>
      )}
    </aside>
  );
}
