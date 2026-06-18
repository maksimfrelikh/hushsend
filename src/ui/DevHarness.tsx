import { useState, type CSSProperties, type ReactElement } from 'react';
import { useSession } from './SessionProvider';
import { useAppSelector } from '../store/hooks';
import { formatBytes } from '../core/transfer/fileTransfer';
import type { SessionController } from '../core/SessionController';
import type { TransferState } from '../store/transferSlice';

/**
 * TEMPORARY step-1 transport harness — NOT a real screen. It only exists to drive
 * two tabs through the no-crypto "room" rendezvous and prove the WebRTC DataChannel
 * comes up (create -> code -> join -> connected -> ping echoes both ways, with DTLS
 * fingerprints logged). Delete this file (and devSlice + its store line) when the
 * real screens land in step 5; styling here is intentionally bare.
 */
export function DevHarness(): ReactElement {
  const session = useSession();
  const status = useAppSelector((s) => s.connection.status);
  const room = useAppSelector((s) => s.connection.room);
  const peerId = useAppSelector((s) => s.connection.peerId);
  const error = useAppSelector((s) => s.connection.error);
  const dev = useAppSelector((s) => s.dev);
  const transfer = useAppSelector((s) => s.transfer);
  const [code, setCode] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const connecting = status === 'creating' || status === 'pairing' || status === 'confirming';

  return (
    <section style={wrap}>
      <p style={eyebrow}>step 1 · transport dev harness (temporary — real screens are step 5)</p>

      <p style={line}>
        status: <strong data-testid="status">{status}</strong>
        {dev.selfId ? ` · you: ${dev.selfId}` : ''}
        {peerId ? ` · peer: ${peerId}` : ''}
      </p>

      {status === 'idle' && (
        <div style={col}>
          <button style={btn} onClick={() => void session.createRoom()}>
            Create room
          </button>
          <div style={row}>
            <input
              style={input}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4-digit code"
              inputMode="numeric"
              maxLength={4}
              aria-label="room code"
            />
            <button style={btn} disabled={!/^\d{4}$/.test(code)} onClick={() => void session.joinRoom(code)}>
              Join
            </button>
          </div>
        </div>
      )}

      {status === 'awaitingPeer' && (
        <p style={line}>
          Share this code: <strong style={code4} data-testid="room-code">{room}</strong> — waiting for a peer to join…
        </p>
      )}

      {status === 'joining' && <p style={line}>Joining room {room}…</p>}
      {connecting && <p style={line}>Connecting… ({status})</p>}

      {status === 'connected' && (
        <div style={col}>
          <p style={line}>
            Connected to {peerId} in room {room}.{' '}
            <span style={{ color: 'var(--faint)' }}>(unauthenticated — step-1 transport only)</span>
          </p>
          <button style={btn} onClick={() => void session.sendPing()}>
            Send ping
          </button>

          <div style={{ ...row, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              multiple
              data-testid="file-input"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <button
              style={btn}
              data-testid="send-btn"
              disabled={files.length === 0}
              onClick={() => session.sendFiles(files)}
            >
              Send {files.length > 1 ? `${files.length} files (zip)` : 'file'}
            </button>
          </div>

          <TransferPanel session={session} transfer={transfer} />
        </div>
      )}

      {status === 'failed' && <p style={{ ...line, color: 'var(--fg)' }}>Failed: {error}</p>}

      {(status === 'connected' || status === 'failed') && (
        <button style={{ ...btn, marginTop: 8 }} onClick={() => session.dispose()}>
          Reset
        </button>
      )}

      <div style={panel}>
        <p style={panelLabel}>DTLS fingerprints</p>
        <p style={mono}>local : {dev.localFingerprint ?? '—'}</p>
        <p style={mono}>remote: {dev.remoteFingerprint ?? '—'}</p>
      </div>

      <div style={panel}>
        <p style={panelLabel}>data-channel log</p>
        {dev.log.length === 0 ? (
          <p style={{ ...mono, color: 'var(--faint)' }}>—</p>
        ) : (
          <ul>
            {dev.log.map((entry, i) => (
              <li key={i} style={mono}>
                {entry}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Transfer status + the incoming-offer accept/reject card. Throwaway dev UI. */
function TransferPanel({
  session,
  transfer,
}: {
  session: SessionController;
  transfer: TransferState;
}): ReactElement | null {
  const { phase, direction, fileName, totalBytes, transferredBytes, error } = transfer;
  if (phase === 'idle') return null;

  const pct = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
  const incoming = phase === 'offered' && direction === 'receive';

  return (
    <div style={panel} data-testid="transfer">
      <p style={panelLabel}>file transfer · {direction}</p>
      <p style={line} data-testid="transfer-phase">
        <strong>{phase}</strong> · {fileName ?? '—'} · {formatBytes(totalBytes)}
      </p>

      {incoming && (
        <div style={row}>
          <button style={btn} data-testid="accept-btn" onClick={() => void session.acceptIncoming()}>
            Accept
          </button>
          <button style={btn} data-testid="reject-btn" onClick={() => session.rejectIncoming()}>
            Reject
          </button>
        </div>
      )}

      {phase === 'offered' && direction === 'send' && <p style={line}>Waiting for peer to accept…</p>}

      {(phase === 'transferring' || phase === 'done') && (
        <>
          <div style={progressTrack} aria-hidden>
            <div style={{ ...progressFill, width: `${pct}%` }} />
          </div>
          <p style={mono} data-testid="transfer-bytes">
            {transferredBytes} / {totalBytes} bytes ({pct}%)
          </p>
        </>
      )}

      {phase === 'done' && <p style={{ ...line, color: 'var(--fg)' }}>✓ complete</p>}
      {(phase === 'rejected' || phase === 'error') && (
        <p style={{ ...line }} data-testid="transfer-reason">
          {phase}: {error}
        </p>
      )}
      {phase === 'cancelled' && <p style={line} data-testid="transfer-reason">cancelled</p>}

      {(phase === 'transferring' || phase === 'offered') && (
        <button style={{ ...btn, marginTop: 8 }} onClick={() => session.cancelTransfer()}>
          Cancel
        </button>
      )}
    </div>
  );
}

// Bare, token-only inline styles (no new scales) — this harness is throwaway.
const wrap: CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: 'var(--gut)',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};
const eyebrow: CSSProperties = {
  fontFamily: 'var(--label-font)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--label-track)',
  fontSize: 'var(--t-meta)',
  color: 'var(--faint)',
};
const line: CSSProperties = { fontSize: 'var(--t-body)' };
const col: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' };
const row: CSSProperties = { display: 'flex', gap: 8 };
const btn: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontWeight: 600,
};
const input: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--line-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.2em',
  width: 140,
};
const code4: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--t-h3)', letterSpacing: '0.2em' };
const panel: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const panelLabel: CSSProperties = { ...eyebrow };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--t-meta)', wordBreak: 'break-all' };
const progressTrack: CSSProperties = {
  height: 8,
  borderRadius: 'var(--r-pill)',
  background: 'var(--line)',
  overflow: 'hidden',
};
const progressFill: CSSProperties = {
  height: '100%',
  background: 'var(--fg)',
  transition: 'width var(--dur-2, 0.2s) var(--ease-out, ease)',
};
