/**
 * Copy table for the screens. ENGLISH ONLY for now: every key carries `en`; `ru` is optional and
 * the translator falls back to `en` when it is missing, so the EN|RU switch stays hidden until the
 * Russian half is complete (prefs.tsx keeps the language state, the header shows no switch). New
 * strings get `en` only. Copy is the owner's placeholder, taken from the Claude Design canvas
 * boards (see CLAUDE.md § UI / styling) except the security sentences, which are the ones the
 * threat model needs said in exactly these words.
 *
 * Pure UI copy — no security-relevant text routes through here in a way tests depend on: the
 * authenticated-state descriptor is a fixed English technical string (TransferScreen
 * `authStateText`), so the e2e substring contract ('authenticated' / 'SAS' / 'reconnect') holds
 * regardless of the selected language.
 */
export type Lang = 'en' | 'ru';

type Entry = { en: string; ru?: string };

export const STR = {
  // --- global ---
  back: { en: 'Back', ru: 'Назад' },
  themeToggle: { en: 'Switch theme' },

  // --- home ---
  homeTitle: { en: 'Secure file transfer' },
  modeGroup: { en: 'Connection mode' },
  modeMax: { en: 'Max privacy', ru: 'Макс. приватность' },
  modeReliable: { en: 'Reliable' },
  modeMaxDesc: {
    en: 'Files travel only between the two devices. If no direct path exists, it does not connect.',
  },
  modeReliableDesc: {
    en: 'If no direct path exists, encrypted traffic is relayed through a server that cannot read it.',
  },
  inviteBtn: { en: 'Invite someone', ru: 'Пригласить' },
  joinBtn: { en: 'Join', ru: 'Войти' },
  roomCodeAria: { en: '4-digit room code', ru: 'Код комнаты' },
  orWords: { en: 'Enter code words', ru: 'Ввести кодовые слова' },
  scanQr: { en: 'Scan a QR code', ru: 'Сканировать QR-код' },
  // Reconnect is symmetric and codeless: tap Reconnect on both devices, they meet by themselves.
  reconnectSection: { en: 'Reconnect' },
  reconnectAction: { en: 'Reconnect', ru: 'Переподключить' },
  forgetDevice: { en: 'Forget' },
  forgetPins: { en: 'Forget pinned devices', ru: 'Забыть устройства' },

  // --- home · About privacy and security (collapsible items) ---
  aboutTitle: { en: 'About privacy and security' },
  aboutMaxTitle: { en: 'What Max privacy changes' },
  privacyDesc: {
    en: 'On: always direct, peer-to-peer. Your peer sees your IP; never relayed through a server — even if that means not connecting. Transfers are padded so their size shows a range, not the exact file (costs up to 12% extra data).',
    ru: 'Вкл: всегда напрямую, точка-точка. Собеседник видит ваш IP; никогда через сервер — даже если соединиться не выйдет. Объём передачи выравнивается, чтобы виден был диапазон, а не точный размер файла (до 12% лишнего трафика).',
  },
  privacyDescReliable: {
    en: 'Off (reliable): if a direct path fails it falls back through a server, so it connects where Max privacy would give up. Your peer still sees your IP either way; the relay only carries end-to-end-encrypted traffic it cannot read.',
    ru: 'Выкл (надёжно): если напрямую не вышло — идёт через сервер, поэтому соединяется там, где «Макс. приватность» сдалась бы. Собеседник всё равно видит ваш IP; relay несёт только сквозь-шифрованный трафик и прочитать его не может.',
  },
  aboutMaxBoth: {
    en: 'In both modes a server introduces the two browsers to each other and then drops out. It never sees a file byte, a secret word or a link secret.',
  },
  /**
   * What the NETWORK can see — the two exposures that are inherent to a direct browser-to-browser
   * transfer and that no amount of cryptography inside the app removes. THREATMODEL.md § 3b and § 4.
   * Both facts are observable from ONE side, with no cooperation from anyone, and neither is visible
   * anywhere else in the UI. Deliberately NOT an alarm: a permanent property, so it lives as a
   * collapsed item with one concrete action at the end.
   */
  netTitle: { en: 'What your network can still see', ru: 'Что всё равно видит ваша сеть' },
  netSummary: { en: 'That you opened hushsend, and who you connected to — never what you sent.' },
  netSni: {
    en: 'Opening this page reveals its address to your internet provider in the clear, before any encryption of the page itself. So the fact that you used a private file-transfer tool is visible to whoever watches your connection — even if nothing is ever sent.',
    ru: 'При открытии этой страницы её адрес уходит вашему интернет-провайдеру в открытом виде — до того, как начинается шифрование самой страницы. То есть сам факт, что вы пользовались инструментом приватной передачи файлов, виден тому, кто наблюдает за вашим соединением, даже если вы ничего не отправите.',
  },
  netDirect: {
    en: 'In Max privacy the transfer goes straight between the two of you, so each side’s provider sees a direct connection to the other side’s address. Establishing that two people were in contact needs data from ONE of the two networks only. The contents cannot be read; the fact of contact cannot be denied.',
    ru: 'В режиме макс. приватности передача идёт напрямую между вами двоими, поэтому провайдер каждой стороны видит прямое соединение с адресом другой. Чтобы установить, что два человека были на связи, достаточно данных ОДНОЙ из двух сетей. Содержимое прочитать нельзя; сам факт связи — отрицать нельзя.',
  },
  netAdvice: {
    en: 'If either of those matters to you, use Tor or a VPN — on BOTH sides. One side alone does not help with the second point.',
    ru: 'Если для вас важно любое из этого — используйте Tor или VPN, причём с ОБЕИХ сторон. Одна сторона от второго пункта не спасает.',
  },
  aboutReconnectTitle: { en: 'How reconnect works' },
  aboutReconnectBody: {
    en: 'A device appears on this page after your first verified connection with it. Tap Reconnect here and on the other device — they find each other. No code is shown or needed. Remove a device to forget its pinned key.',
  },

  // --- method ---
  methodTitle: { en: 'How should we connect?', ru: 'Как соединить устройства?' },
  mLinkQr: { en: 'Link or QR code' },
  mLinkQrDesc: { en: 'One-time link, shown as a code too' },
  mWords: { en: 'Code words', ru: 'Кодовые слова' },
  mWordsDesc: { en: 'Read five words aloud', ru: 'Продиктуйте пять слов' },
  mRoom: { en: 'Room', ru: 'Комната' },
  mRoomDesc: { en: 'Create a room and share its code', ru: 'Создайте комнату и поделитесь кодом' },

  // --- shared actions ---
  copy: { en: 'Copy', ru: 'Копировать' },
  copyLink: { en: 'Copy link' },
  copyCode: { en: 'Copy code' },
  copied: { en: 'Copied', ru: 'Скопировано' },
  share: { en: 'Share', ru: 'Поделиться' },

  // --- share (link + QR are ONE screen) ---
  shareTitle: { en: 'Share this link' },
  qrAlt: { en: 'QR code of the invite link' },

  // --- scan (qr receive) ---
  scanTitle: { en: 'Scan their QR code', ru: 'Отсканируйте их QR-код' },
  scanViewfinderAria: { en: 'Camera viewfinder' },
  scanViewfinder: { en: 'Point at the code on the other screen' },
  scanCameraError: {
    en: 'Camera unavailable — paste the link below instead.',
    ru: 'Камера недоступна — вставьте ссылку ниже.',
  },
  scanPasteTitle: { en: 'Or paste the link' },
  scanPasteAria: { en: 'Invite link' },
  scanPastePlaceholder: { en: 'paste the invite link…', ru: 'вставьте ссылку-приглашение…' },
  scanJoin: { en: 'Join', ru: 'Войти' },
  scanInvalid: { en: 'That isn’t a valid hushsend link.', ru: 'Это не похоже на ссылку hushsend.' },

  // --- words · read (host) ---
  wcrTitle: { en: 'Read these words aloud' },
  attemptsSuffix: { en: 'failed attempts', ru: 'неудачных попыток' },

  // --- words · enter (joiner) ---
  pakeTitle: { en: 'Enter the words they read', ru: 'Введите названные слова' },
  wordPlaceholder: { en: 'Word' },
  suggestionsAria: { en: 'Suggestions' },
  pakeNoMatch: { en: 'No matching word', ru: 'Нет совпадений' },
  pakeCta: { en: 'Connect', ru: 'Соединиться' },

  // --- room lobby (mesh: roster + pick whom to connect with) ---
  lobbyRoomTitle: {
    en: 'Share the code, then pick who to connect with',
    ru: 'Поделись кодом и выбери, с кем соединиться',
  },
  roomCodeLabel: { en: 'Room code' },
  lobbyEmpty: {
    en: 'Waiting · share the code so someone can join…',
    ru: 'Ожидание · поделитесь кодом, чтобы кто-то вошёл…',
  },
  lobbyJoined: { en: 'joined', ru: 'вошёл' },
  lobbyBusySuffix: {
    en: 'is busy with another peer — pick someone else.',
    ru: 'занят с другим — выберите другого.',
  },

  // --- connecting ---
  creatingTitle: { en: 'Creating session…', ru: 'Создаём сессию…' },
  joiningTitle: { en: 'Joining…', ru: 'Подключаемся…' },
  pairingTitle: { en: 'Agreeing on keys…', ru: 'Согласуем ключи…' },
  confirmingTitle: { en: 'Verifying…', ru: 'Проверяем…' },

  // --- reconnect wait (the derived rendezvous — nothing to show, nothing to type) ---
  rwTitle: { en: 'Waiting for the other device', ru: 'Ждём другое устройство' },
  rwDesc: { en: 'Open hushsend on it and tap Reconnect on this device’s row.' },

  // --- SAS · reader (shows its phrase and reads it aloud) ---
  sasReaderTitle: { en: 'Read this phrase aloud', ru: 'Прочитайте фразу вслух' },
  /** The only gate on this side: clicking through without hearing the peer is the one way a human
   *  can hand a MITM the session. Stays directly above the confirm button. */
  sasReaderWarn: { en: 'Only continue once you have HEARD your peer say these words back.' },
  sasReaderConfirm: { en: 'They read it back — connect' },
  sasReaderAbort: { en: 'Stop — they don’t have this phrase' },
  // --- SAS · picker (BLIND — identifies the phrase by listening) ---
  sasTitle: { en: 'Which phrase is your peer reading?', ru: 'Какую фразу называет собеседник?' },
  sasGroupAria: { en: 'Phrases' },
  sasConfirm: { en: 'Confirm choice', ru: 'Подтвердить выбор' },
  sasNone: { en: 'None of these match — stop', ru: 'Ни одна не совпадает — остановить' },
  // --- SAS fail-closed (role could not be resolved — missing id; never a functional blind picker) ---
  sasRestartEyebrow: { en: 'verification interrupted', ru: 'проверка прервана' },
  sasRestartTitle: {
    en: 'Can’t verify safely — restart',
    ru: 'Не удаётся проверить — начните заново',
  },
  sasRestartDesc: {
    en: 'We could not determine who reads and who listens for this verification (the session lost its peer details). Start over so the check is done safely — do not send files until you do.',
    ru: 'Не удалось определить, кто читает, а кто слушает при этой проверке (сессия потеряла данные собеседника). Начните заново, чтобы проверка прошла безопасно — не передавайте файлы до этого.',
  },
  sasRestartBtn: { en: 'Restart verification', ru: 'Начать проверку заново' },

  // --- transfer ---
  trTitle: { en: 'Secure channel open' },
  /** Path attestation rows. Deliberately say what was CHECKED, not what is guaranteed: the check is
   *  advisory. THREE states, and they must stay distinguishable. `unknown` ("could not check") is the
   *  ordinary result on browsers that cannot enumerate their own addresses, Safari above all, and is
   *  not an accusation. `mismatch` ("checked, and it disagreed") is the only positive evidence this
   *  system can produce, so it cannot share a label — nor the `unknown` copy, which blames the browser
   *  and on a mismatch is simply untrue. Both causes are named and the user is given something to do. */
  pathOk: { en: 'direct path confirmed', ru: 'прямой путь подтверждён' },
  pathUnknown: { en: 'direct path not confirmed', ru: 'прямой путь не подтверждён' },
  pathUnknownHint: {
    en: 'Your files are still encrypted end-to-end and unreadable to anyone in between. What could not be confirmed here is WHICH route they took: one of the two browsers did not report enough to check. Safari never does.',
    ru: 'Файлы всё равно зашифрованы сквозным образом и нечитаемы для любого посредника. Не удалось подтвердить только МАРШРУТ: один из двух браузеров не сообщил достаточно данных для проверки. Safari не сообщает их никогда.',
  },
  /** Shown ONLY when two or more STUN servers disagreed about our public address. Never shown for
   *  "they agree" or "nothing to compare": a badge that is always green is a badge people stop
   *  reading, which is the lesson F2 taught. */
  stunDisagree: { en: 'address servers disagree', ru: 'серверы адреса расходятся' },
  stunDisagreeHint: {
    en: 'The servers that tell this browser its own public address gave different answers. That can be honest — a connection with two providers, or a large carrier NAT, genuinely has more than one. It can also mean one of them is not telling the truth, which matters because the route check trusts that address. Your files are encrypted either way.',
    ru: 'Серверы, которые сообщают браузеру его собственный публичный адрес, ответили по-разному. Это бывает честно — при двух провайдерах или крупном операторском NAT адресов действительно несколько. А бывает, что один из них говорит неправду, и это важно: проверка маршрута опирается на этот адрес. Файлы зашифрованы в любом случае.',
  },
  pathMismatch: { en: 'route did not match', ru: 'маршрут не совпал' },
  pathMismatchHint: {
    en: 'The address this connection actually used is not one your correspondent listed. Your files are still encrypted end-to-end and unreadable to anyone in between — this is about the ROUTE, not the contents. Two things cause it: some browsers (Safari above all) cannot report the address they were reached on, or something is carrying your connection through itself. If that distinction matters to you, stop here and reconnect over a different network.',
    ru: 'Адрес, по которому реально прошло соединение, не совпал ни с одним из названных вашим собеседником. Файлы всё равно зашифрованы сквозным образом и нечитаемы для любого посредника — речь о МАРШРУТЕ, не о содержимом. Причин две: некоторые браузеры (прежде всего Safari) не могут сообщить адрес, по которому к ним обратились, — либо соединение кто-то пропускает через себя. Если для вас эта разница существенна, остановитесь и переподключитесь через другую сеть.',
  },
  zoneEmpty: { en: 'Tap to add files, or drop them here' },
  zoneMore: { en: 'Add more files' },
  chooseFiles: { en: 'Choose files' },
  fileInputAria: { en: 'Choose files to send' },
  removeFile: { en: 'Remove' },
  sendBtn: { en: 'Send', ru: 'Отправить' },
  fileOne: { en: 'file' },
  fileMany: { en: 'files' },
  sendingTitle: { en: 'Sending' },
  receivingTitle: { en: 'Receiving' },
  incomingTitle: { en: 'Incoming file', ru: 'Входящий файл' },
  incomingFrom: { en: 'from', ru: 'от' },
  accept: { en: 'Accept', ru: 'Принять' },
  decline: { en: 'Decline', ru: 'Отклонить' },
  deliveredTitle: { en: 'Delivered', ru: 'Доставлено' },
  receivedTitle: { en: 'Received', ru: 'Получено' },
  endedTitle: { en: 'Transfer ended' },
  rejectedLabel: { en: 'declined', ru: 'отклонено' },
  cancelledLabel: { en: 'cancelled', ru: 'отменено' },
  errorLabel: { en: 'transfer error', ru: 'ошибка передачи' },
  stoppedAt: { en: 'stopped at' },
  cancel: { en: 'Cancel', ru: 'Отмена' },
  newTransfer: { en: 'New transfer', ru: 'Новая передача' },
  closeChannel: { en: 'Close channel', ru: 'Закрыть канал' },

  // --- failed (ONE screen, variants) ---
  erMismatchEyebrow: { en: 'numbers didn’t match', ru: 'не совпало' },
  erMismatchTitle: {
    en: 'This channel may be compromised',
    ru: 'Канал может быть скомпрометирован',
  },
  erMismatchDesc: {
    en: 'The phrase you confirmed doesn’t match your peer’s. Someone may be intercepting — don’t send files.',
    ru: 'Подтверждённая фраза не совпала с фразой собеседника. Кто-то может перехватывать — не передавайте файлы.',
  },
  exEyebrow: { en: 'error · room not found', ru: 'ошибка · комната не найдена' },
  exTitle: { en: 'Room not found or code expired', ru: 'Комната не найдена или код истёк' },
  exDesc: {
    en: 'No active room has this code, or it has already expired. Check the digits or start your own room.',
    ru: 'Нет активной комнаты с таким кодом, либо он уже истёк. Проверьте цифры или создайте свою комнату.',
  },
  erGenericEyebrow: { en: 'connection failed', ru: 'соединение не удалось' },
  erGenericTitle: { en: 'Couldn’t connect', ru: 'Не удалось соединиться' },
  // Max-privacy STRICT model: never relays — a direct failure is terminal (step 6d).
  directFailEyebrow: { en: 'direct connection failed', ru: 'прямое соединение не удалось' },
  directFailTitle: { en: 'Couldn’t connect directly', ru: 'Не удалось соединиться напрямую' },
  directFailHint: { en: 'Switch to Reliable to allow relaying through a server.' },
  // Reliable mode: the relay we were promised was not there (see connectionSlice.relayUnavailable).
  relayUnavailableHint: {
    en: 'Reliable mode found no relay, so this attempt ran direct-only — the fallback you chose this mode for was not there. If it keeps happening the relay is down or misconfigured, not your network.',
    ru: 'Надёжный режим не получил реле, поэтому попытка шла только напрямую — запасного пути, ради которого вы выбрали этот режим, не было. Если это повторяется — дело в реле (не работает или настроено неверно), а не в вашей сети.',
  },
  noShowEyebrow: { en: 'reconnect · nobody came', ru: 'переподключение · никто не пришёл' },
  noShowTitle: { en: 'The other device did not show up', ru: 'Другое устройство не появилось' },
  noShowDesc: {
    en: 'Make sure Reconnect was tapped on it too, and that it still lists this device. If it has forgotten this pairing (storage cleared), connect a new way — a fresh pairing will pin it again.',
    ru: 'Убедитесь, что «Переподключить» нажали и там, и что это устройство ещё в его списке. Если оно забыло сопряжение (очищено хранилище), соединитесь заново любым способом — новое сопряжение снова его запомнит.',
  },
  newWords: { en: 'New words', ru: 'Новые слова' },
  backHome: { en: 'Back home', ru: 'На главную' },

  // --- key changed (inverts the whole viewport — danger = inversion, never red) ---
  kcTitle: { en: 'This device’s key changed', ru: 'Ключ этого устройства изменился' },
  kcDesc: {
    en: 'The signature no longer matches the key we pinned. Your peer may have reinstalled or switched devices — or someone is impersonating them. Do not send files until you re-verify out of band.',
    ru: 'Подпись больше не совпадает с запиненным ключом. Возможно, собеседник переустановил приложение или сменил устройство — либо кто-то выдаёт себя за него. Не передавайте файлы, пока не сверитесь по второму каналу.',
  },
  kcAbort: { en: 'Don’t connect', ru: 'Не соединяться' },
} as const satisfies Record<string, Entry>;

export type StrKey = keyof typeof STR;

/** Translate a copy key; a language without that string falls back to English. */
export function translate(key: StrKey, lang: Lang): string {
  const entry: Entry = STR[key];
  return (lang === 'ru' && entry.ru) || entry.en;
}
