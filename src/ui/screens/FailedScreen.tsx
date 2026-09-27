import { type ReactElement, type ReactNode } from 'react';
import { useSession } from '../SessionProvider';
import { useAppSelector } from '../../store/hooks';
import { formatBytes } from '../../core/transfer/fileTransfer';
import { useT } from '../prefs';
import { Screen, Space, Pill, TextLink, Kicker, Glyph } from '../ui';

/**
 * ONE terminal failure screen with variants, classified from the error text and the method:
 * compromised (SAS / key-confirmation mismatch), room not found, nobody came (reconnect), direct
 * path failed (Max privacy, ± the missing-relay hint in Reliable), connection lost (an AUTHENTICATED
 * channel died — with the last file's outcome), generic, and the words method, which additionally
 * offers fresh words. There is no "Try again". Each surfaces the raw reason as a mono line and one
 * exit.
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
        <div className="hs-failed" data-testid="key-changed">
          <Glyph name="warn" size={48} className="hs-failed__glyph" />
          <Space h={24} />
          <h2 className="hs-h2">{t('kcTitle')}</h2>
          <Space h={14} />
          <p className="hs-p hs-p--narrow">{t('kcDesc')}</p>
          <Space h={16} />
          <span className="hs-reason" data-testid="error">
            {error}
          </span>
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
  const isExpired = /(not found|expired|4009|room full|signaling closed)/.test(lower);
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
        : isExpired
          ? 'expired'
          : isDirectFail
            ? 'direct'
            : 'generic';
  const copy = {
    mismatch: {
      kicker: t('erMismatchEyebrow'),
      title: t('erMismatchTitle'),
      desc: t('erMismatchDesc'),
    },
    noShow: { kicker: t('noShowEyebrow'), title: t('noShowTitle'), desc: t('noShowDesc') },
    expired: { kicker: t('exEyebrow'), title: t('exTitle'), desc: t('exDesc') },
    direct: {
      kicker: t('directFailEyebrow'),
      title: t('directFailTitle'),
      desc: t('directFailHint'),
    },
    // Title, the file, the signal — nothing else. An eyebrow or a description would only say "lost"
    // again, and could not honestly say WHOSE side dropped (it may well be this one).
    lost: { kicker: '', title: t('lostTitle'), desc: '' },
    generic: { kicker: t('erGenericEyebrow'), title: t('erGenericTitle'), desc: '' },
  }[variant];

  return (
    <FailureLayout
      variant={variant}
      kicker={copy.kicker}
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
        ) : null
      }
      // The lost variant's title already says "lost"; its mono line keeps only which signal said so.
      reason={variant === 'lost' ? error.replace(/^connection lost:\s*/i, '') : error}
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
  const t = useT();
  const { phase, direction, fileName, totalBytes, transferredBytes } = useAppSelector(
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
  );
}

/** The failure composition shared by every variant (and by the SAS fail-closed restart): glyph,
 *  optional mono kicker, title, optional description(s), the raw reason, the actions column.
 *  `variant` is exposed as `data-variant` for tooling and tests. */
export function FailureLayout({
  variant,
  kicker,
  title,
  desc,
  descTestId,
  extra,
  reason,
  actions,
}: {
  variant?: string;
  kicker?: string;
  title: string;
  desc?: string;
  descTestId?: string;
  extra?: ReactNode;
  reason?: string;
  actions: ReactNode;
}): ReactElement {
  return (
    <Screen center>
      <div className="hs-failed" data-testid="failure" data-variant={variant}>
        <Glyph name="warn" size={40} className="hs-failed__glyph" />
        <Space h={24} />
        {kicker && (
          <>
            <Kicker>{kicker}</Kicker>
            <Space h={10} />
          </>
        )}
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
