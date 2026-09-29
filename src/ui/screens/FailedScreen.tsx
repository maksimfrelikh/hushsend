import { type ReactElement, type ReactNode } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { formatBytes } from '../../core/transfer/fileTransfer';
import { useT } from '../prefs';
import { Screen, Space, Pill, TextLink, Glyph } from '../ui';
import { onMacDesktop } from '../platform';

/**
 * ONE terminal failure screen with variants, classified from the error text and the method:
 * compromised (SAS / key-confirmation mismatch — the description names the cause THIS side saw),
 * our own code expired while we waited in its room, room not found or code expired, lost the connection
 * to the server (a signaling drop that is not a room answer), nobody came (reconnect), direct path
 * failed (Max privacy, ± the missing-relay hint in Reliable), connection lost (an AUTHENTICATED channel
 * died — with the last file's outcome), generic, and the words method, which additionally offers fresh
 * words. There is no "Try again".
 *
 * NOTHING IS SAID TWICE (owner's rule, 2026-09-27): a title, and a description only where it tells the
 * user something the title does not. The mono eyebrows that paraphrased every title are gone, and the
 * raw reason is shown only where it is the one specific fact on the screen (the generic variant, and
 * the connection-lost variant's signal) — everywhere else it only repeated the copy. It stays on the
 * container as `data-reason` for tooling and tests.
 *
 * The reconnect KEY-CHANGED case is the hard stop: it inverts the WHOLE viewport (danger = inversion,
 * never red — App.tsx adds `hs-app--inverted`), and the only action is "Don't connect". No bytes ever
 * flow: only `connected` renders the transfer surface.
 */
export function FailedScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const error = useAppSelector((s) => s.connection.error) ?? '';
  const method = useAppSelector((s) => s.connection.method);
  const reconnectOutcome = useAppSelector((s) => s.dev.reconnect.outcome);
  // Reliable only (Max privacy never requests creds, so this is always false there): the relay this
  // mode exists to provide was not available, which is WHY the attempt behaved like Max privacy.
  const relayUnavailable = useAppSelector((s) => s.connection.relayUnavailable);
  // Whether this session ever had a file on the wire (the connection-lost variant then shows it).
  const hadTransfer = useAppSelector((s) => s.transfer.phase !== 'idle' && !!s.transfer.fileName);

  if (reconnectOutcome === 'key-changed') {
    return (
      <Screen center>
        <div className="hs-failed" data-testid="key-changed" data-reason={error}>
          <Glyph name="warn" size={48} className="hs-failed__glyph" />
          <Space h={24} />
          <h2 className="hs-h2">{t('kcTitle')}</h2>
          <Space h={14} />
          <p className="hs-p hs-p--narrow">{t('kcDesc')}</p>
          <Space h={36} />
          <div className="hs-failed__actions">
            <Pill variant="primary" block testId="reset-btn" onClick={() => session.dispose()}>
              {t('kcAbort')}
            </Pill>
          </div>
        </div>
      </Screen>
    );
  }

  const lower = error.toLowerCase();
  const isMismatch = /(match|man-in-the-middle|tamper|mismatch|compromis)/.test(lower);
  // Our own code ran out while we waited in its room with nobody engaged — keyed off the stable
  // WAIT_EXPIRED_REASON marker, and checked BEFORE the joiner's generic not-found/expired below.
  const isWaitExpired = /nobody joined/.test(lower);
  // A room answer: gone (4009 / a dead token), expired (4010), full (4002).
  const isExpired = /(not found|expired|4009|4010|4002|room full)/.test(lower);
  // Any OTHER signaling close — 1006 above all: the network or the server went away while pairing.
  // It used to fall into `expired` ("Room not found or code expired — Check the digits") and told a
  // person who typed no digits to check them (BACKLOG § UX bugs, the Android emulator).
  const isServerLost = /signaling closed/.test(lower);
  // Max-privacy STRICT model: a direct ICE failure is terminal (Max-privacy never relays). Surface a
  // hint to switch to Reliable. Keyed off the stable reason DIRECT_FAIL_REASON sets in the core.
  const isDirectFail = /connect directly|max privacy/.test(lower);
  // Codeless reconnect: the wait cap fired with nobody at the rendezvous. Keyed off the stable
  // RECONNECT_NO_SHOW_REASON marker the core sets.
  const isNoShow = /did not show up/.test(lower);
  // An AUTHENTICATED channel died after `connected`. Keyed off CONNECTION_LOST_PREFIX
  // (`connection lost: <which signal>`).
  const isLost = lower.startsWith('connection lost');

  const variant = isMismatch
    ? 'mismatch'
    : isLost
      ? 'lost'
      : isNoShow
        ? 'noShow'
        : isWaitExpired
          ? 'waitExpired'
          : isExpired
            ? 'expired'
            : isServerLost
              ? 'server'
              : isDirectFail
                ? 'direct'
                : 'generic';
  // The same hard-stop title for every mismatch; the description says what THIS side actually saw.
  const mismatchDesc = /peer reported a sas mismatch/.test(lower)
    ? t('erSasPeerDesc')
    : /sas rejected/.test(lower)
      ? t('erSasRejectDesc')
      : /key-confirmation mismatch/.test(lower) && method === 'words'
        ? t('erWordsKeyDesc')
        : t('erMismatchDesc');
  const waitCopy =
    method === 'words'
      ? { title: t('waitWordsTitle'), desc: t('waitWordsDesc') }
      : method === 'link' || method === 'qr'
        ? { title: t('waitLinkTitle'), desc: t('waitLinkDesc') }
        : { title: t('waitRoomTitle'), desc: t('waitRoomDesc') };
  const copy = {
    mismatch: { title: t('erMismatchTitle'), desc: mismatchDesc },
    waitExpired: waitCopy,
    noShow: { title: t('noShowTitle'), desc: t('noShowDesc') },
    expired: { title: t('exTitle'), desc: t('exDesc') },
    server: { title: t('serverLostTitle'), desc: t('serverLostDesc') },
    direct: { title: t('directFailTitle'), desc: t('directFailHint') },
    // Title, the file, the signal. A description could not honestly say WHOSE side dropped.
    lost: { title: t('lostTitle'), desc: '' },
    generic: { title: t('erGenericTitle'), desc: '' },
  }[variant];
  // The mono line only where it is the one specific fact: the generic variant's raw reason, and the
  // lost variant's signal (its title already says "lost"). Elsewhere it only repeated the copy.
  const reason =
    variant === 'lost'
      ? error.replace(/^connection lost:\s*/i, '')
      : variant === 'generic'
        ? error
        : undefined;

  return (
    <FailureLayout
      variant={variant}
      rawReason={error}
      title={copy.title}
      desc={copy.desc}
      descTestId={variant === 'direct' ? 'direct-fail-hint' : undefined}
      extra={
        variant === 'lost' ? (
          // The session was authenticated and is over; what the user still needs is the file.
          hadTransfer ? (
            <LastTransfer />
          ) : null
        ) : relayUnavailable ? (
          <p className="hs-p hs-p--muted hs-p--narrow" data-testid="relay-unavailable-hint">
            {t('relayUnavailableHint')}
          </p>
        ) : variant === 'direct' && onMacDesktop() ? (
          <p className="hs-p hs-p--muted hs-p--narrow" data-testid="local-network-hint">
            {t('localNetworkHint')}
          </p>
        ) : null
      }
      reason={reason}
      actions={
        // Fresh words fix a CODE problem (wrong, spent, expired). A lost connection is not one — the
        // words did their job — so it gets the plain exit.
        method === 'words' && variant !== 'lost' ? (
          <>
            <Pill
              variant="primary"
              block
              testId="new-words-btn"
              onClick={() => void session.regenerate()}
            >
              {t('newWords')}
            </Pill>
            <TextLink testId="reset-btn" onClick={() => session.dispose()}>
              {t('backHome')}
            </TextLink>
          </>
        ) : (
          <Pill variant="primary" block testId="reset-btn" onClick={() => session.dispose()}>
            {t('backHome')}
          </Pill>
        )
      }
    />
  );
}

/**
 * The connection-lost variant's one fact: what became of the last file. The core fails an in-flight
 * transfer BEFORE it ends the session and leaves the transfer projection in place (see
 * SessionController.onConnectionLost), so this reads the same state the transfer screen did — a file
 * delivered a moment before the other tab closed still says delivered. Nothing when nothing was ever
 * offered on this channel.
 */
function LastTransfer(): ReactElement | null {
  const session = useSession();
  const t = useT();
  const { phase, direction, fileName, totalBytes, transferredBytes, saveNeeded } = useAppSelector(
    (s) => s.transfer,
  );
  if (phase === 'idle' || !fileName) return null;
  const done = phase === 'done';
  const receiving = direction === 'receive';
  const outcome = done
    ? t(receiving ? 'receivedLabel' : 'deliveredLabel')
    : phase === 'rejected'
      ? t('rejectedLabel')
      : phase === 'cancelled'
        ? t('cancelledLabel')
        : t(receiving ? 'notReceivedLabel' : 'notDeliveredLabel');
  const aside =
    done || transferredBytes === 0
      ? formatBytes(totalBytes)
      : `${t('stoppedAt')} ${formatBytes(transferredBytes)}`;
  return (
    <>
      <div
        className={`hs-box hs-failed__transfer${done ? '' : ' hs-box--ended'}`}
        data-testid="last-transfer"
        data-outcome={phase}
      >
        <div className="hs-box__head">
          <span className="hs-box__label">{outcome}</span>
          <span className="hs-box__aside">{aside}</span>
        </div>
        <div className="hs-file">
          <span className="hs-file__name">{fileName}</span>
          {done && <Glyph name="check" size={20} />}
        </div>
      </div>
      {done && saveNeeded && (
        // Received while the page was hidden and not saved yet — the file is still here to save,
        // connection or not.
        <>
          <Space h={12} />
          <div className="hs-failed__actions">
            <Pill
              variant="primary"
              block
              testId="save-file-btn"
              onClick={() => session.saveReceived()}
            >
              {t('saveFile')}
            </Pill>
          </div>
        </>
      )}
    </>
  );
}

/** The failure composition shared by every variant (and by the SAS fail-closed restart): glyph,
 *  title, optional description(s), the raw reason where it says something new, the actions column.
 *  `variant` is exposed as `data-variant` for tooling and tests. */
export function FailureLayout({
  variant,
  rawReason,
  title,
  desc,
  descTestId,
  extra,
  reason,
  actions,
}: {
  variant?: string;
  /** The full failure reason, kept on the container for tooling and tests even where the screen
   *  does not show it (see FailedScreen: nothing is said twice). */
  rawReason?: string;
  title: string;
  desc?: string;
  descTestId?: string;
  extra?: ReactNode;
  reason?: string;
  actions: ReactNode;
}): ReactElement {
  return (
    <Screen center>
      <div
        className="hs-failed"
        data-testid="failure"
        data-variant={variant}
        data-reason={rawReason}
      >
        <Glyph name="warn" size={40} className="hs-failed__glyph" />
        <Space h={24} />
        <h2 className="hs-h2">{title}</h2>
        {desc && (
          <>
            <Space h={12} />
            <p className="hs-p hs-p--muted hs-p--narrow" data-testid={descTestId}>
              {desc}
            </p>
          </>
        )}
        {extra && (
          <>
            <Space h={12} />
            {extra}
          </>
        )}
        {reason && (
          <>
            <Space h={16} />
            <span className="hs-reason" data-testid="error">
              {reason}
            </span>
          </>
        )}
        <Space h={36} />
        <div className="hs-failed__actions">{actions}</div>
      </div>
    </Screen>
  );
}
