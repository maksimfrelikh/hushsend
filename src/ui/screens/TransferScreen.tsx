import { useRef, useState, type DragEvent, type ReactElement } from 'react';
import { onCoarsePointer } from '../platform';
import { transferWakeLock } from '../wakeLock';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { formatBytes } from '../../core/transfer/fileTransfer';
import { usePrefs, useT } from '../prefs';
import type { StrKey } from '../i18n';
import type { ConnectionMethod } from '../../store/connectionSlice';
import { type TransferState } from '../../store/transferSlice';
import {
  Screen,
  Space,
  Grow,
  Pill,
  TextLink,
  IconButton,
  Disclosure,
  Glyph,
  AlertLine,
} from '../ui';

/**
 * Connected + transfer screen — the ONLY screen from which file bytes can flow (it renders only at
 * status `connected`, i.e. after authentication). The heading "Secure channel open" is the only
 * status on the happy path; how the channel was authenticated stays in the DOM as a screen-reader
 * line (`auth-state`). The path check appears as collapsible rows under the heading ONLY in its
 * non-ok states. One transfer = one row (the protocol sends one payload; several files travel as one
 * zip), one progress bar, one Cancel; the outcomes (delivered / declined / cancelled / error) render
 * inside the same container, then "New transfer".
 */
export function TransferScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const method = useAppSelector((s) => s.connection.method);
  const reconnectOutcome = useAppSelector((s) => s.dev.reconnect.outcome);
  const pathCheck = useAppSelector((s) => s.connection.pathCheck);
  const stunDisagreed = useAppSelector((s) => s.connection.stunDisagreed);
  const interrupted = useAppSelector((s) => s.connection.interrupted);
  const transfer = useAppSelector((s) => s.transfer);

  const idle = transfer.phase === 'idle';
  const hasRows = (pathCheck !== null && pathCheck !== 'ok') || stunDisagreed || interrupted;

  // Reset ONLY the per-transfer projection (progress / file name / phase) back to idle — a clean
  // ready-to-send for the next send. Does NOT touch the connection (the channel stays open) and does
  // NOT clear the session-only history (those records persist). Through the core, so a received file
  // still waiting for "Save file" is let go of too.
  const newTransfer = (): void => {
    session.resetTransfer();
  };

  return (
    <Screen>
      <h2 className="hs-h2">{t('trTitle')}</h2>
      {/* Fixed English descriptor of HOW the channel was authenticated — see authStateText. */}
      <span className="sr-only" data-testid="auth-state">
        {authStateText(method, reconnectOutcome)}
      </span>

      {/* Path attestation. THREE states, and they must stay distinguishable. `ok` says nothing on the
          screen (a badge that is always green is a badge people stop reading) but keeps its verdict
          in the DOM for tooling. `unknown` is the ordinary "could not check" — muted words alone.
          `mismatch` is a check that RAN and DISAGREED: foreground words with the alert glyph, and a
          hint that names both causes. Neither is a teardown: the check is advisory
          (core/pathAttest.ts), no byte is gated on it. */}
      {pathCheck === 'ok' && (
        <span className="sr-only" data-testid="path-state" data-path-verdict="ok">
          {t('pathOk')}
        </span>
      )}
      {hasRows && (
        <>
          <Space h={12} />
          {/* ICE `disconnected`: nothing is arriving, so the progress below is not live — say so
              instead of letting it pose as a working transfer (TESTPLAN F2). It either clears by
              itself or the core ends the session as lost. */}
          {interrupted && <AlertLine testId="interrupted">{t('interrupted')}</AlertLine>}
          {/* Reliable mode fell back to the relay: say so, quietly — it is the mode working as chosen,
              not an alarm, and it is NOT "direct path confirmed" (which is what `ok` used to claim). */}
          {pathCheck === 'relayed' && (
            <Disclosure
              title={t('pathRelayed')}
              tone="muted"
              testId="path-state"
              panelTestId="path-hint"
              attrs={{ 'data-path-verdict': 'relayed' }}
            >
              {t('pathRelayedHint')}
            </Disclosure>
          )}
          {pathCheck === 'unknown' && (
            <Disclosure
              title={t('pathUnknown')}
              tone="muted"
              testId="path-state"
              panelTestId="path-hint"
              attrs={{ 'data-path-verdict': 'unknown' }}
            >
              {t('pathUnknownHint')}
            </Disclosure>
          )}
          {pathCheck === 'mismatch' && (
            <Disclosure
              title={t('pathMismatch')}
              tone="alert"
              testId="path-state"
              panelTestId="path-hint"
              attrs={{ 'data-path-verdict': 'mismatch' }}
            >
              {t('pathMismatchHint')}
            </Disclosure>
          )}
          {/* Only ever rendered on a DISAGREEMENT — see i18n stunDisagree for why there is no green twin. */}
          {stunDisagreed && (
            <Disclosure
              title={t('stunDisagree')}
              tone="alert"
              testId="stun-state"
              panelTestId="stun-hint"
            >
              {t('stunDisagreeHint')}
            </Disclosure>
          )}
          <Space h={16} />
        </>
      )}
      {!hasRows && <Space h={idle ? 24 : 28} />}

      {idle ? <Picker /> : <TransferPanel transfer={transfer} onNewTransfer={newTransfer} />}

      <TextLink testId="reset-btn" onClick={() => session.dispose()}>
        {t('closeChannel')}
      </TextLink>
    </Screen>
  );
}

/** The clean ready-to-send state: the file zone, the picked files, Send. One hidden file input;
 *  the zone (a label) and the "Choose files" pill both open it. */
function Picker(): ReactElement {
  const session = useSession();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);

  const add = (list: FileList | null): void => {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>): void => {
    e.preventDefault();
    setOver(false);
    add(e.dataTransfer.files);
  };
  const count = files.length;
  const label = count > 1 ? `${t('sendBtn')} · ${count} ${t('fileMany')}` : t('sendBtn');

  return (
    <>
      <label
        className={`hs-zone${count > 0 ? ' hs-zone--compact' : ''}${over ? ' hs-zone--over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          className="hs-zone__input"
          type="file"
          multiple
          aria-label={t('fileInputAria')}
          data-testid="file-input"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = ''; // so picking the same file again re-fires change
          }}
        />
        <Glyph name="paperclip" size={28} />
        <span className="hs-zone__text">{count > 0 ? t('zoneMore') : t('zoneEmpty')}</span>
      </label>
      {count > 0 ? (
        <>
          <Space h={16} />
          <div className="hs-filelist">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="hs-file">
                <span className="hs-file__name">{f.name}</span>
                <span className="hs-file__size">{formatBytes(f.size)}</span>
                <IconButton
                  glyph="x"
                  label={`${t('removeFile')} ${f.name}`}
                  className="hs-iconbtn--edge"
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                />
              </div>
            ))}
          </div>
          <Space h={16} />
          <Pill variant="primary" block testId="send-btn" onClick={() => {
              transferWakeLock().poke();
              session.sendFiles(files);
            }}>
            {label}
          </Pill>
        </>
      ) : (
        <>
          <Space h={20} />
          <Pill variant="primary" block onClick={() => inputRef.current?.click()}>
            {t('chooseFiles')}
          </Pill>
        </>
      )}
      <Space h={4} />
    </>
  );
}

/** The live transfer: incoming offer accept/decline, the single send row with its progress, and the
 *  terminal states inside the same container. */
function TransferPanel({
  transfer,
  onNewTransfer,
}: {
  transfer: TransferState;
  onNewTransfer: () => void;
}): ReactElement {
  const session = useSession();
  const t = useT();
  const peerId = useAppSelector((s) => s.connection.peerId);
  const { phase, direction, fileName, totalBytes, transferredBytes, error } = transfer;

  const { privacyMode } = usePrefs();
  // The keep-the-screen-on line is for phones (a coarse pointer): a desktop that sleeps does not drop
  // its WebRTC connection the way iOS Safari does on lock (TESTPLAN F1), and the wake lock in App.tsx
  // covers the idle timer; this line covers what it cannot — a deliberate lock or an app switch.
  const [coarsePointer] = useState(onCoarsePointer);
  const pct = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
  const incoming = phase === 'offered' && direction === 'receive';
  const inFlight = phase === 'offered' || phase === 'transferring';
  const done = phase === 'done';
  const ended = phase === 'rejected' || phase === 'cancelled' || phase === 'error';
  // Every declared byte has crossed but the transfer has not ended: the sender is pushing the volume
  // padding (Max privacy) and then waiting for `received`; the receiver is dropping that padding and
  // closing its sink. No progress is emitted for any of it by design, so without a word the bar sits
  // at 100% looking dead — minutes on a slow link (TESTPLAN B10, 2026-10-02). Say what is going on.
  const finishing = phase === 'transferring' && totalBytes > 0 && transferredBytes >= totalBytes;
  const name = fileName ?? '—';
  const title = finishing ? t('finishingTitle') : panelTitle(transfer, t);
  const finishingHint = !finishing
    ? null
    : privacyMode === 'max'
      ? t(direction === 'send' ? 'finishingPadSend' : 'finishingPadReceive')
      : t(direction === 'send' ? 'finishingConfirm' : 'finishingSave');

  const progressText = `${formatPair(transferredBytes, totalBytes)} · ${pct}%`;
  const progress = (
    <div className="hs-send">
      <div className="hs-send__head">
        <span className="hs-file__name">{name}</span>
        <span className="hs-file__size">{progressText}</span>
      </div>
      <div
        className="hs-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${title} ${name}`}
      >
        <span className="hs-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      {finishingHint && (
        <p className="hs-meta hs-send__finishing" data-testid="transfer-finishing" role="status">
          {finishingHint}
        </p>
      )}
      {phase === 'transferring' && coarsePointer && (
        <p className="hs-meta hs-send__keepon" data-testid="transfer-keep-on">
          {t('keepScreenOn')}
        </p>
      )}
    </div>
  );

  return (
    <div className="hs-panel" data-testid="transfer">
      {/* raw FSM phase + raw byte counter, for tooling/tests; the human-readable label is the h3 and
          the visible counter is the boards' "12.4 / 48.0 MB · 26%" */}
      <span className="sr-only" data-testid="transfer-phase">
        {phase}
      </span>
      {(phase === 'transferring' || done) && (
        <span className="sr-only" data-testid="transfer-bytes">
          {transferredBytes} / {totalBytes} bytes ({pct}%)
        </span>
      )}
      <h3 className="hs-h3">{title}</h3>
      {incoming && (
        <>
          <Space h={4} />
          <p className="hs-meta hs-mono">
            {t('incomingFrom')} {peerId ?? '—'}
          </p>
        </>
      )}
      <Space h={12} />
      <div className={`hs-box${ended ? ' hs-box--ended' : ''}`}>
        {incoming && (
          <div className="hs-file">
            <span className="hs-file__name">{name}</span>
            <span className="hs-file__size">{formatBytes(totalBytes)}</span>
          </div>
        )}
        {!incoming && inFlight && progress}
        {done && (
          <div className="hs-file hs-file--tall">
            <span className="hs-file__name">{name}</span>
            <span className="hs-file__size">{formatBytes(totalBytes)}</span>
            <Glyph name="check" size={20} />
          </div>
        )}
        {ended && (
          <>
            {/* the label + a SHORT aside ("stopped at 12 MB") share one line; a reason that is a sentence
                (a refusal names the cap and what to do) gets its own line — on a phone it ran off the
                right edge of the row (owner's screenshot, 2026-10-03). `transfer-reason` wraps both. */}
            <div data-testid="transfer-reason">
              <div className="hs-box__head">
                <span className="hs-box__label">{endedLabel(phase, t)}</span>
                <span className="hs-box__aside">
                  {phase === 'cancelled' && transferredBytes > 0
                    ? `${t('stoppedAt')} ${formatBytes(transferredBytes)}`
                    : ''}
                </span>
              </div>
              {error && <p className="hs-meta hs-box__reason">{error}</p>}
            </div>
            {transferredBytes > 0 ? (
              progress
            ) : (
              <div className="hs-file">
                <span className="hs-file__name">{name}</span>
                <span className="hs-file__size">{formatBytes(totalBytes)}</span>
              </div>
            )}
          </>
        )}
      </div>

      <Grow />
      <Space h={20} />
      {incoming && (
        <>
          <Pill
            variant="primary"
            block
            testId="accept-btn"
            onClick={() => {
              transferWakeLock().poke();
              void session.acceptIncoming();
            }}
          >
            {t('accept')}
          </Pill>
          <Space h={4} />
          <TextLink testId="reject-btn" onClick={() => session.rejectIncoming()}>
            {t('decline')}
          </TextLink>
        </>
      )}
      {!incoming && inFlight && (
        <TextLink onClick={() => session.cancelTransfer()}>{t('cancel')}</TextLink>
      )}
      {done && transfer.saveNeeded && (
        // The file arrived while the page was hidden, so the browser was never asked to save it (iOS
        // drops a download started then) — the tap does it now, in a real user gesture.
        <>
          <p className="hs-p hs-p--muted" data-testid="save-hint">
            {t('saveFileHint')}
          </p>
          <Space h={12} />
          <Pill
            variant="primary"
            block
            testId="save-file-btn"
            onClick={() => session.saveReceived()}
          >
            {t('saveFile')}
          </Pill>
          <Space h={4} />
        </>
      )}
      {(done || ended) && (
        <>
          <Pill
            variant={done && transfer.saveNeeded ? 'secondary' : 'primary'}
            block
            testId="new-transfer-btn"
            onClick={onNewTransfer}
          >
            {t('newTransfer')}
          </Pill>
          <Space h={4} />
        </>
      )}
    </div>
  );
}

/** "12.4 / 48.0 MB": both numbers in the unit the TOTAL picks, one decimal, the unit once. */
function formatPair(done: number, total: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let div = 1;
  while (total / div >= 1024 && i < units.length - 1) {
    div *= 1024;
    i++;
  }
  const f = (n: number): string => (i === 0 ? String(n) : (n / div).toFixed(1));
  return `${f(done)} / ${f(total)} ${units[i]}`;
}

function panelTitle(transfer: TransferState, t: (k: StrKey) => string): string {
  const { phase, direction } = transfer;
  if (phase === 'offered') return direction === 'receive' ? t('incomingTitle') : t('sendingTitle');
  if (phase === 'transferring')
    return direction === 'receive' ? t('receivingTitle') : t('sendingTitle');
  if (phase === 'done') return direction === 'receive' ? t('receivedTitle') : t('deliveredTitle');
  return t('endedTitle');
}

function endedLabel(phase: TransferState['phase'], t: (k: StrKey) => string): string {
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
