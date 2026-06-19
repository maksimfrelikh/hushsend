import { useEffect, useState, type ReactElement } from 'react';
import { useSession } from '../SessionProvider';
import { useT } from '../prefs';
import { useSessionRole } from '../sessionRole';
import { Screen, Eyebrow, BackLink, PrivacyToggle } from '../ui';
import { WordPicker } from '../components/WordPicker';
import { ScanScreen } from './ScanScreen';
import { loadRecentDevices, deviceLabel } from '../recentDevices';
import { forgetTransfers } from '../persistence';
import type { PinEntry } from '../../core/keystore';

type View = 'landing' | 'method' | 'wordsJoin' | 'scan';

/**
 * The idle home. A self-contained pre-session flow (no router): landing → method picker (the
 * "Invite someone" create paths) and landing → words receive. Joining by code, reconnecting to a
 * recent device, and the disabled "Max privacy" toggle all live on the landing. Every action calls
 * a SessionController method, which moves the FSM off `idle` and hands the screen to the router.
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
      <Screen center>
        <Eyebrow parts={[t('pakeEyebrow')]} />
        <h2 className="hs-h2">{t('pakeTitle')}</h2>
        <p className="hs-sub">{t('pakeDesc')}</p>
        <WordPicker onJoin={(words) => void session.joinWordsSession(words)} />
        <BackLink onClick={() => setView('landing')} />
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
  const { markCreator, markJoiner } = useSessionRole();
  const [joinCode, setJoinCode] = useState('');
  const [reconnectCode, setReconnectCode] = useState('');
  // Recent devices are read from the keystore (the source of pins), not from localStorage.
  const [devices, setDevices] = useState<PinEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void loadRecentDevices().then((d) => {
      if (alive) setDevices(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 4);
  const joinOk = /^\d{4}$/.test(joinCode);
  const reconnectOk = /^\d{4}$/.test(reconnectCode);

  const onForget = (): void => {
    void session.resetIdentity(); // wipes keystore pins (+ regenerates identity)
    forgetTransfers(); // and the non-key transfer history
    setDevices([]);
  };

  return (
    <Screen>
      <PrivacyToggle />

      <Eyebrow parts={[t('he1'), t('he2'), t('he3')]} />
      <h1 className="hs-h1">{t('homeTitle')}</h1>

      <button
        type="button"
        className="hs-btn hs-btn--primary hs-btn--block"
        data-testid="invite-btn"
        onClick={onInvite}
      >
        {t('inviteBtn')}
      </button>

      <div className="hs-divider">
        <span>{t('joinHere')}</span>
      </div>

      <div className="hs-join-row">
        <input
          className="hs-input hs-input--code"
          value={joinCode}
          onChange={(e) => setJoinCode(digits(e.target.value))}
          placeholder="— — — —"
          inputMode="numeric"
          maxLength={4}
          aria-label={t('roomCodeAria')}
          data-testid="room-sas-input"
        />
        <button
          type="button"
          className="hs-btn hs-btn--ghost"
          data-testid="join-room-sas-btn"
          disabled={!joinOk}
          onClick={() => {
            markJoiner(); // joiner = blind SAS picker
            void session.joinRoomSession(joinCode);
          }}
        >
          {t('joinBtn')}
        </button>
      </div>

      <button type="button" className="hs-btn hs-btn--ghost hs-btn--block" data-testid="enter-words-btn" onClick={onWords}>
        {t('orWords')}
      </button>
      <button type="button" className="hs-btn hs-btn--ghost hs-btn--block" data-testid="scan-qr-btn" onClick={onScan}>
        {t('scanQr')}
      </button>

      <p className="hs-section-label">{t('homeKnown')}</p>

      {devices.length === 0 ? (
        <p className="hs-sub">{t('noRecent')}</p>
      ) : (
        <div className="hs-stack">
          {devices.map((d, i) => (
            <div key={d.pairingId} className="hs-device">
              <span className="hs-dot hs-dot--on" aria-hidden="true" />
              <div className="hs-row__body">
                <div className="hs-row__title">{deviceLabel(d)}</div>
                <div className="hs-meta">{d.peerPublicKey.slice(0, 16)}…</div>
              </div>
              <button
                type="button"
                className="hs-btn hs-btn--ghost hs-btn--sm"
                data-testid={i === 0 ? 'create-reconnect-btn' : undefined}
                onClick={() => {
                  markCreator(); // creator = SAS reader (if reconnect falls back to SAS)
                  void session.createReconnectSession();
                }}
              >
                {t('reconnectAction')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="hs-join-row">
        <input
          className="hs-input hs-input--code"
          value={reconnectCode}
          onChange={(e) => setReconnectCode(digits(e.target.value))}
          placeholder="— — — —"
          inputMode="numeric"
          maxLength={4}
          aria-label={t('reconnectCodeAria')}
          data-testid="reconnect-input"
        />
        <button
          type="button"
          className="hs-btn hs-btn--ghost"
          data-testid="join-reconnect-btn"
          disabled={!reconnectOk}
          onClick={() => {
            markJoiner(); // joiner = blind SAS picker (if reconnect falls back to SAS)
            void session.joinReconnectSession(reconnectCode);
          }}
        >
          {t('reconnectByCode')}
        </button>
      </div>

      {devices.length > 0 && (
        <button type="button" className="hs-textlink" data-testid="reset-identity-btn" onClick={onForget}>
          {t('forgetPins')}
        </button>
      )}
    </Screen>
  );
}

function MethodView({ onBack }: { onBack: () => void }): ReactElement {
  const session = useSession();
  const t = useT();
  const { markCreator } = useSessionRole();
  return (
    <Screen wide>
      <Eyebrow parts={[t('methodEyebrow')]} />
      <h2 className="hs-h2">{t('methodTitle')}</h2>
      <div className="hs-stack">
        <MethodRow
          num="01"
          title={t('mLink')}
          desc={t('mLinkDesc')}
          testId="create-link-btn"
          onClick={() => void session.createLinkSession('link')}
        />
        <MethodRow
          num="02"
          title={t('mQr')}
          desc={t('mQrDesc')}
          testId="create-qr-btn"
          onClick={() => void session.createLinkSession('qr')}
        />
        <MethodRow
          num="03"
          title={t('mWords')}
          desc={t('mWordsDesc')}
          testId="create-words-btn"
          onClick={() => void session.createWordsSession()}
        />
        <MethodRow
          num="04"
          title={t('mRoom')}
          desc={t('mRoomDesc')}
          testId="create-room-sas-btn"
          onClick={() => {
            markCreator(); // creator = SAS reader (shows its phrase, reads it aloud)
            void session.createRoomSession();
          }}
        />
      </div>
      <BackLink onClick={onBack} />
    </Screen>
  );
}

function MethodRow({
  num,
  title,
  desc,
  onClick,
  soon,
  testId,
}: {
  num: string;
  title: string;
  desc: string;
  onClick?: () => void;
  soon?: boolean;
  testId?: string;
}): ReactElement {
  const t = useT();
  return (
    <button type="button" className="hs-row" data-testid={testId} disabled={soon} onClick={onClick}>
      <span className="hs-row__num">{num}</span>
      <span className="hs-row__body">
        <span className="hs-row__title">{title}</span>
        <span className="hs-row__desc">{desc}</span>
      </span>
      <span className="hs-row__aside">{soon ? <span className="hs-soon">{t('soon')}</span> : '→'}</span>
    </button>
  );
}
