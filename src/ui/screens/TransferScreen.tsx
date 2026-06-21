import { useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { formatBytes } from '../../core/transfer/fileTransfer';
import { useT } from '../prefs';
import type { StrKey } from '../i18n';
import type { ConnectionMethod } from '../../store/connectionSlice';
import { transferActions, type TransferState } from '../../store/transferSlice';
import { Screen, Eyebrow } from '../ui';

/**
 * Connected + transfer screen — the ONLY screen from which file bytes can flow (it renders only at
 * status `connected`, i.e. after authentication). Carries the verified badge, the file picker, and
 * the live transfer panel (offer / progress / done / incoming accept-reject), plus channel close.
 */
export function TransferScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const dispatch = useAppDispatch();
  const method = useAppSelector((s) => s.connection.method);
  const reconnectOutcome = useAppSelector((s) => s.dev.reconnect.outcome);
  const transfer = useAppSelector((s) => s.transfer);
  const [files, setFiles] = useState<File[]>([]);

  // Drop zone + file selection show ONLY in a clean idle state. A finished/aborted transfer parks on
  // its terminal plaque with an explicit "New transfer" button (below) so the done state never lingers
  // alongside a fresh pick — each send starts from a clean slate.
  const idle = transfer.phase === 'idle';
  const terminal =
    transfer.phase === 'done' ||
    transfer.phase === 'cancelled' ||
    transfer.phase === 'rejected' ||
    transfer.phase === 'error';

  // Reset ONLY the per-transfer projection (progress / file name / phase) back to idle and clear the
  // local file pick — a clean ready-to-send for the next send. Does NOT touch the connection (the
  // channel stays open) and does NOT clear the session-only history (those records persist).
  const newTransfer = (): void => {
    dispatch(transferActions.reset());
    setFiles([]);
  };

  return (
    <Screen wide>
      <Eyebrow parts={[t('trEyebrow')]} />
      <span className="hs-badge hs-badge--verified" data-testid="auth-state">
        ✓ {authStateText(method, reconnectOutcome)}
      </span>
      <h2 className="hs-h2">{t('trTitle')}</h2>

      {idle && (
        <label className="hs-drop">
          <span className="hs-drop__title">{t('dropTitle')}</span>
          <span className="hs-sub">{t('dropDesc')}</span>
          <input
            type="file"
            multiple
            data-testid="file-input"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
      )}

      {idle && files.length > 0 && (
        <div className="hs-stack">
          {files.map((f, i) => (
            <div key={i} className="hs-file">
              <span className="hs-file__name">{f.name}</span>
              <span className="hs-meta">{formatBytes(f.size)}</span>
            </div>
          ))}
          <button
            type="button"
            className="hs-btn hs-btn--primary hs-btn--block"
            data-testid="send-btn"
            disabled={files.length === 0}
            onClick={() => session.sendFiles(files)}
          >
            {t('sendBtn')}
            {files.length > 1 ? ` · ${files.length} files` : ''}
          </button>
        </div>
      )}

      <TransferPanel transfer={transfer} />

      {terminal && (
        <button
          type="button"
          className="hs-btn hs-btn--primary hs-btn--block"
          data-testid="new-transfer-btn"
          onClick={newTransfer}
        >
          {t('newTransfer')}
        </button>
      )}

      <button type="button" className="hs-textlink" data-testid="reset-btn" onClick={() => session.dispose()}>
        {t('closeChannel')}
      </button>
    </Screen>
  );
}

/** The live transfer panel: incoming offer accept/reject, send/receive progress, terminal states. */
function TransferPanel({ transfer }: { transfer: TransferState }): ReactElement | null {
  const session = useSession();
  const t = useT();
  const { phase, direction, fileName, totalBytes, transferredBytes, error } = transfer;
  if (phase === 'idle') return null;

  const pct = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
  const incoming = phase === 'offered' && direction === 'receive';
  const active = phase === 'transferring' || phase === 'done';

  return (
    <div className="hs-plaque" data-testid="transfer">
      {/* raw FSM phase, for tooling/tests; the human-readable label is the plaque title below */}
      <span className="sr-only" data-testid="transfer-phase">
        {phase}
      </span>
      <div className="hs-plaque__head">
        {phase === 'done' ? <span className="hs-check">✓</span> : <span className="hs-spinner" aria-hidden="true" />}
        <span className="hs-plaque__title">{plaqueTitle(transfer, t)}</span>
        {active && <span className="hs-meta">{phase === 'done' ? t('done') : `${pct}%`}</span>}
      </div>

      <p className="hs-meta">
        {fileName ?? '—'} · {formatBytes(totalBytes)}
      </p>

      {incoming && (
        <div className="hs-row-actions">
          <button
            type="button"
            className="hs-btn hs-btn--primary hs-btn--sm"
            data-testid="accept-btn"
            onClick={() => void session.acceptIncoming()}
          >
            {t('accept')}
          </button>
          <button
            type="button"
            className="hs-btn hs-btn--ghost hs-btn--sm"
            data-testid="reject-btn"
            onClick={() => session.rejectIncoming()}
          >
            {t('decline')}
          </button>
        </div>
      )}

      {phase === 'offered' && direction === 'send' && <p className="hs-meta">{t('awaitAccept')}</p>}

      {active && (
        <>
          <div className="hs-progress" aria-hidden="true">
            <div className="hs-progress__fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="hs-meta" data-testid="transfer-bytes">
            {transferredBytes} / {totalBytes} bytes ({pct}%)
          </p>
        </>
      )}

      {(phase === 'rejected' || phase === 'error' || phase === 'cancelled') && (
        <p className="hs-meta" data-testid="transfer-reason">
          {phase}
          {error ? `: ${error}` : ''}
        </p>
      )}

      {(phase === 'transferring' || phase === 'offered') && (
        <button type="button" className="hs-btn hs-btn--ghost hs-btn--sm" onClick={() => session.cancelTransfer()}>
          {t('cancel')}
        </button>
      )}
    </div>
  );
}

function plaqueTitle(transfer: TransferState, t: (k: StrKey) => string): string {
  const { phase, direction } = transfer;
  if (phase === 'offered') return direction === 'receive' ? t('incomingTitle') : t('plaqueSending');
  if (phase === 'transferring') return t('plaqueSending');
  if (phase === 'done') return direction === 'receive' ? t('plaqueReceived') : t('plaqueDelivered');
  if (phase === 'rejected') return t('rejectedLabel');
  if (phase === 'cancelled') return t('cancelledLabel');
  return t('errorLabel');
}

/**
 * Fixed English technical descriptor of HOW the channel was authenticated. Deliberately NOT routed
 * through i18n so the substrings the e2e asserts ('authenticated' for words, 'SAS' for the room,
 * 'reconnect' for the pinned-key path) are stable regardless of the selected language.
 */
function authStateText(method: ConnectionMethod | null, reconnectOutcome: string | null): string {
  if (reconnectOutcome === 'authenticated') return 'reconnect — verified via pinned key';
  if (method === 'words') return 'authenticated — code words verified';
  if (method === 'link' || method === 'qr') return 'authenticated — one-time secret verified';
  return 'verified — SAS confirmed';
}
