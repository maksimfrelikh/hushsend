import { useCallback, useEffect, useState, type KeyboardEvent, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { usePrefs, useT } from '../prefs';
import {
  Screen,
  Space,
  Grow,
  Pill,
  TextLink,
  BackLink,
  IconButton,
  Collapsible,
  Glyph,
} from '../ui';
import { WordPicker } from '../components/WordPicker';
import { ScanScreen } from './ScanScreen';
import { loadRecentDevices, deviceLabel, forgetDevice } from '../recentDevices';
import { useAppDispatch } from '../../store/hooks';
import { historyActions } from '../../store/historySlice';
import type { PinEntry } from '../../core/keystore';

type View = 'landing' | 'method' | 'wordsJoin' | 'scan';

/**
 * The idle home. A self-contained pre-session flow (no router): landing → method picker (the
 * "Invite someone" create paths), landing → words receive, landing → QR scan. Joining by code,
 * reconnecting to a paired device (one tap, no code) and the Max privacy / Reliable mode all live on
 * the landing. Every action calls a SessionController method, which moves the FSM off `idle` and
 * hands the screen to the router.
 */
export function HomeScreen(): ReactElement {
  const session = useSession();
  const t = useT();
  const [view, setView] = useState<View>('landing');

  if (view === 'method') {
    return <MethodView onBack={() => setView('landing')} />;
  }
  if (view === 'wordsJoin') {
    return (
      <Screen>
        <h2 className="hs-h2">{t('pakeTitle')}</h2>
        <Space h={24} />
        <WordPicker
          onJoin={(words) => void session.joinWordsSession(words)}
          onBack={() => setView('landing')}
        />
      </Screen>
    );
  }
  if (view === 'scan') {
    return <ScanScreen onBack={() => setView('landing')} />;
  }
  return (
    <LandingView
      onInvite={() => setView('method')}
      onWords={() => setView('wordsJoin')}
      onScan={() => setView('scan')}
    />
  );
}

function LandingView({
  onInvite,
  onWords,
  onScan,
}: {
  onInvite: () => void;
  onWords: () => void;
  onScan: () => void;
}): ReactElement {
  const session = useSession();
  const t = useT();
  const dispatch = useAppDispatch();
  const [joinCode, setJoinCode] = useState('');
  // Paired devices are read from the keystore (the source of pins), not from localStorage.
  const [devices, setDevices] = useState<PinEntry[]>([]);
  const refreshDevices = useCallback(() => {
    let alive = true;
    void loadRecentDevices().then((d) => {
      if (alive) setDevices(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(refreshDevices, [refreshDevices]);

  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 4);
  const joinOk = /^\d{4}$/.test(joinCode);
  const join = (): void => {
    if (joinOk) void session.joinRoomSession(joinCode);
  };

  const onForgetAll = (): void => {
    void session.resetIdentity(); // wipes keystore pins (+ regenerates identity)
    dispatch(historyActions.forgotten()); // and the in-memory (session-only) transfer history
    setDevices([]);
  };
  const onForgetOne = (d: PinEntry): void => {
    setDevices((list) => list.filter((x) => x.peerPublicKey !== d.peerPublicKey));
    void forgetDevice(d.peerPublicKey).then(refreshDevices);
  };

  return (
    <Screen>
      <h1 className="hs-h1">{t('homeTitle')}</h1>
      <Space h={32} />
      <ModeControl />
      <Space h={32} />
      <Pill variant="primary" block testId="invite-btn" onClick={onInvite}>
        {t('inviteBtn')}
      </Pill>
      <Space h={36} />

      <form
        className="hs-form-row hs-form-row--center"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          className="hs-input hs-input--code"
          value={joinCode}
          onChange={(e) => setJoinCode(digits(e.target.value))}
          placeholder="————"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          aria-label={t('roomCodeAria')}
          data-testid="room-sas-input"
          autoComplete="off"
        />
        <Pill testId="join-room-sas-btn" disabled={!joinOk} onClick={join}>
          {t('joinBtn')}
        </Pill>
      </form>
      <Space h={10} />
      <div className="hs-pill-col">
        <Pill block testId="enter-words-btn" onClick={onWords}>
          {t('orWords')}
        </Pill>
        <Pill block testId="scan-qr-btn" onClick={onScan}>
          {t('scanQr')}
        </Pill>
      </div>

      {/*
        Reconnect is SYMMETRIC and codeless: each side taps Reconnect on the other's row, both derive
        the same rendezvous from the pairing secret and meet there. Nothing to type. The section only
        exists once a device has been pinned.
      */}
      {devices.length > 0 && (
        <>
          <Space h={40} />
          <h3 className="hs-h3">{t('reconnectSection')}</h3>
          <Space h={8} />
          {devices.map((d, i) => {
            const label = deviceLabel(d);
            return (
              <div key={d.pairingId} className="hs-device">
                <div className="hs-device__body">
                  <div className="hs-device__label">{label}</div>
                  <span className="hs-device__fp">{d.peerPublicKey.slice(0, 16)}…</span>
                </div>
                <Pill
                  size="sm"
                  testId={i === 0 ? 'reconnect-btn' : undefined}
                  onClick={() => void session.reconnectTo(d.pairingId)}
                >
                  {t('reconnectAction')}
                </Pill>
                <IconButton
                  glyph="x"
                  label={`${t('forgetDevice')} ${label}`}
                  className="hs-iconbtn--edge"
                  onClick={() => onForgetOne(d)}
                />
              </div>
            );
          })}
          <Space h={4} />
          <TextLink align="start" testId="reset-identity-btn" onClick={onForgetAll}>
            {t('forgetPins')}
          </TextLink>
        </>
      )}

      <Space h={40} />
      <h3 className="hs-h3">{t('aboutTitle')}</h3>
      <Space h={8} />
      <Collapsible title={t('aboutMaxTitle')}>
        <p>{t('privacyDesc')}</p>
        <p>{t('privacyDescReliable')}</p>
        <p>{t('aboutMaxBoth')}</p>
      </Collapsible>
      {/*
        What the NETWORK can see — the two exposures cryptography inside the app cannot remove
        (THREATMODEL.md § 3b and § 4), stated where someone decides whether to use this at all. A
        collapsed item on purpose: both facts are PERMANENT properties, not events, and an always-open
        warning would train people to dismiss the rows that DO signal events (the transfer path rows).
      */}
      <Collapsible title={t('netTitle')} testId="network-exposure">
        <p>{t('netSummary')}</p>
        <p>{t('netSni')}</p>
        <p>{t('netDirect')}</p>
        <p>{t('netAdvice')}</p>
      </Collapsible>
      <Collapsible title={t('aboutReconnectTitle')}>
        <p>{t('aboutReconnectBody')}</p>
      </Collapsible>
    </Screen>
  );
}

/**
 * Max privacy / Reliable as a two-word radio group with a one-line description (step 6d, functional).
 * Max privacy: connections stay direct, never relayed — a direct path that cannot come up fails
 * terminally. Reliable: if a direct path fails the connection may fall back through a TURN relay,
 * which carries only end-to-end-encrypted traffic. Neither hides your IP from the PEER; the long
 * texts live in "About privacy and security" below. The state is a persisted pref (prefs.tsx,
 * default Max) read at pairing start, so a flip affects the NEXT connection.
 *
 * Keyboard: the checked radio is the tab stop, arrows move the selection (WAI-ARIA radio group).
 */
function ModeControl(): ReactElement {
  const t = useT();
  const { privacyMode, setPrivacyMode } = usePrefs();
  const max = privacyMode === 'max';
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const next = max ? 'reliable' : 'max';
      setPrivacyMode(next);
      const el = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
        `[data-mode="${next}"]`,
      );
      el?.focus();
    }
  };
  return (
    <div className="hs-mode">
      <div role="radiogroup" aria-label={t('modeGroup')} className="hs-mode__group">
        <button
          type="button"
          role="radio"
          aria-checked={max}
          tabIndex={max ? 0 : -1}
          className="hs-mode__radio"
          data-mode="max"
          data-testid="privacy-toggle"
          onClick={() => setPrivacyMode('max')}
          onKeyDown={onKey}
        >
          {t('modeMax')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!max}
          tabIndex={max ? -1 : 0}
          className="hs-mode__radio"
          data-mode="reliable"
          data-testid="privacy-reliable"
          onClick={() => setPrivacyMode('reliable')}
          onKeyDown={onKey}
        >
          {t('modeReliable')}
        </button>
      </div>
      <p className="hs-mode__desc" data-testid="privacy-desc">
        {max ? t('modeMaxDesc') : t('modeReliableDesc')}
      </p>
    </div>
  );
}

function MethodView({ onBack }: { onBack: () => void }): ReactElement {
  const session = useSession();
  const t = useT();
  return (
    <Screen>
      <h2 className="hs-h2">{t('methodTitle')}</h2>
      <Space h={28} />
      <div className="hs-rows">
        {/* Link and QR are ONE screen (Share): the same one-time link, shown as a QR too. */}
        <MethodRow
          title={t('mLinkQr')}
          desc={t('mLinkQrDesc')}
          testId="create-link-btn"
          onClick={() => void session.createLinkSession('link')}
        />
        <MethodRow
          title={t('mWords')}
          desc={t('mWordsDesc')}
          testId="create-words-btn"
          onClick={() => void session.createWordsSession()}
        />
        <MethodRow
          title={t('mRoom')}
          desc={t('mRoomDesc')}
          testId="create-room-sas-btn"
          onClick={() => void session.createRoomSession()}
        />
      </div>
      <Grow />
      <Space h={20} />
      <BackLink onClick={onBack} />
    </Screen>
  );
}

function MethodRow({
  title,
  desc,
  onClick,
  testId,
}: {
  title: string;
  desc: string;
  onClick: () => void;
  testId: string;
}): ReactElement {
  return (
    <button type="button" className="hs-row" data-testid={testId} onClick={onClick}>
      <span className="hs-row__body">
        <span className="hs-row__title">{title}</span>
        <span className="hs-row__desc">{desc}</span>
      </span>
      <Glyph name="arrow" size={18} className="hs-row__arrow" />
    </button>
  );
}
