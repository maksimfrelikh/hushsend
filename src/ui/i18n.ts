/**
 * Tiny bilingual (EN / RU) copy table for the real screens. The mockups are
 * bilingual, so the language toggle is functional. Keys map to `{ en, ru }`; the
 * active language is read from the prefs context (see prefs.tsx). This is pure UI
 * copy — no security-relevant text routes through here, and nothing is persisted
 * except the user's language preference.
 *
 * Note: the authenticated-state descriptor (the "verified" badge) is NOT routed
 * through here — it is a fixed English technical string (see authStateText), so the
 * substring contract the e2e relies on ('authenticated' / 'SAS' / 'reconnect') holds
 * regardless of the selected language.
 */
export type Lang = 'en' | 'ru';

type Entry = { en: string; ru: string };

export const STR = {
  // --- global ---
  back: { en: '← back', ru: '← назад' },
  soon: { en: 'soon', ru: 'скоро' },

  // --- home ---
  privacyTitle: { en: 'Max privacy', ru: 'Макс. приватность' },
  privacyDesc: {
    en: 'On: always direct, peer-to-peer. Your peer sees your IP; never relayed through a server — even if that means not connecting.',
    ru: 'Вкл: всегда напрямую, точка-точка. Собеседник видит ваш IP; никогда через сервер — даже если соединиться не выйдет.',
  },
  privacyDescReliable: {
    en: 'Off (reliable): may relay through a server if a direct path fails. Your IP stays hidden from your peer; the relay only carries end-to-end-encrypted traffic.',
    ru: 'Выкл (надёжно): может идти через сервер, если напрямую не вышло. Ваш IP скрыт от собеседника; relay видит только сквозь-шифрованный трафик.',
  },
  he1: { en: 'end-to-end encrypted', ru: 'сквозное шифрование' },
  he2: { en: 'no logs', ru: 'без логов' },
  he3: { en: 'nothing stored', ru: 'ничего не хранится' },
  homeTitle: { en: 'Send files device to device', ru: 'Передавайте файлы напрямую' },
  inviteBtn: { en: 'Invite someone', ru: 'Пригласить' },
  joinHere: { en: 'or join with a code', ru: 'или войти по коду' },
  joinBtn: { en: 'Join', ru: 'Войти' },
  roomCodeAria: { en: 'Room code', ru: 'Код комнаты' },
  orWords: { en: 'Enter code words', ru: 'Ввести кодовые слова' },
  homeKnown: { en: 'Recent devices', ru: 'Недавние устройства' },
  reconnectAction: { en: 'reconnect', ru: 'переподключить' },
  noRecent: {
    en: 'No paired devices yet — a device appears here after your first verified connection.',
    ru: 'Пока нет сопряжённых устройств — они появятся после первого проверенного соединения.',
  },
  reconnectByCode: { en: 'Reconnect by code', ru: 'Переподключить по коду' },
  reconnectCodeAria: { en: 'Reconnect code', ru: 'Код переподключения' },
  lastSeen: { en: 'last seen', ru: 'был(а)' },

  // --- method ---
  methodEyebrow: { en: 'sending · step 1 of 3', ru: 'отправка · шаг 1 из 3' },
  methodTitle: { en: 'How should we connect?', ru: 'Как соединить устройства?' },
  mLink: { en: 'Link', ru: 'Ссылка' },
  mLinkDesc: { en: 'One-time invite link', ru: 'Одноразовая ссылка-приглашение' },
  mQr: { en: 'QR code', ru: 'QR-код' },
  mQrDesc: { en: 'Point the other camera here', ru: 'Наведите камеру другого устройства' },
  mWords: { en: 'Code words', ru: 'Кодовые слова' },
  mWordsDesc: { en: 'Read five words aloud', ru: 'Продиктуйте пять слов' },
  mRoom: { en: 'Room', ru: 'Комната' },
  mRoomDesc: { en: 'Create a room and share its code', ru: 'Создайте комнату и поделитесь кодом' },

  // --- room create ---
  rcrEyebrow: { en: 'room · created', ru: 'комната · создана' },
  rcrTitle: {
    en: "Share the code with whoever you're waiting for",
    ru: 'Поделись кодом с тем, кого ждёшь',
  },
  copy: { en: 'Copy', ru: 'Копировать' },
  copied: { en: 'Copied', ru: 'Скопировано' },
  share: { en: 'Share', ru: 'Поделиться' },
  rcrWaiting: {
    en: "You're first in the room · waiting for someone to join…",
    ru: 'Ты первый в комнате · ждём, пока кто-то войдёт…',
  },

  // --- room lobby (mesh: roster + pick whom to connect with) ---
  lobbyRoomEyebrow: { en: 'room · lobby', ru: 'комната · лобби' },
  lobbyRoomTitle: { en: 'Share the code, then pick who to connect with', ru: 'Поделись кодом и выбери, с кем соединиться' },
  lobbyEmpty: {
    en: 'Waiting · share the code so someone can join…',
    ru: 'Ожидание · поделитесь кодом, чтобы кто-то вошёл…',
  },
  lobbyConnect: { en: 'Connect', ru: 'Соединить' },
  lobbyJoined: { en: 'joined', ru: 'вошёл' },
  lobbyDeviceUnknown: { en: 'device', ru: 'устройство' },
  lobbyBusyPrefix: { en: '', ru: '' },
  lobbyBusySuffix: { en: 'is busy with another peer — pick someone else.', ru: 'занят с другим — выберите другого.' },

  // --- words create ---
  wcrEyebrow: { en: 'code words · read aloud', ru: 'кодовые слова · вслух' },
  wcrTitle: { en: 'Read these words', ru: 'Продиктуйте слова' },
  wcrDesc: {
    en: 'Say all five aloud, in order. The first word is the room; the other four are the secret.',
    ru: 'Назовите все пять по порядку. Первое слово — комната; остальные четыре — секрет.',
  },
  waiting: { en: 'Waiting for your peer to join…', ru: 'Ожидаем подключения собеседника…' },
  attempts: { en: 'failed attempts', ru: 'неудачных попыток' },

  // --- words join ---
  pakeEyebrow: { en: 'receive · code words', ru: 'приём · кодовые слова' },
  pakeTitle: { en: 'Enter the words they read', ru: 'Введите названные слова' },
  pakeDesc: {
    en: 'Type each word — pick it from the suggestions as you go.',
    ru: 'Вводите каждое слово — выбирайте из подсказок по мере набора.',
  },
  pakePlaceholder: { en: 'type a word…', ru: 'введите слово…' },
  pakeNoMatch: { en: 'No matching word', ru: 'Нет совпадений' },
  pakeCta: { en: 'Connect', ru: 'Соединиться' },

  // --- link create (one-time invite link) ---
  lcrEyebrow: { en: 'link · one-time', ru: 'ссылка · одноразовая' },
  lcrTitle: { en: 'Send this one-time link', ru: 'Отправьте одноразовую ссылку' },
  lcrDesc: {
    en: 'Anyone with this link can connect once. The secret rides in the part after #, which never reaches the server.',
    ru: 'Любой, у кого есть ссылка, может подключиться один раз. Секрет — в части после #, она не уходит на сервер.',
  },

  // --- qr create (same link, shown as a QR) ---
  qcrEyebrow: { en: 'qr · one-time', ru: 'qr · одноразовый' },
  qcrTitle: { en: 'Show this QR code', ru: 'Покажите этот QR-код' },
  qcrDesc: {
    en: 'Point the other device’s camera at this code. It carries the same one-time secret as the link.',
    ru: 'Наведите камеру другого устройства на код. В нём тот же одноразовый секрет, что и в ссылке.',
  },

  // --- qr receive (scan) ---
  scanEyebrow: { en: 'receive · scan qr', ru: 'приём · сканирование qr' },
  scanTitle: { en: 'Scan their QR code', ru: 'Отсканируйте их QR-код' },
  scanDesc: {
    en: 'Point your camera at the QR code on the other screen.',
    ru: 'Наведите камеру на QR-код на другом экране.',
  },
  scanCameraError: {
    en: 'Camera unavailable — paste the link below instead.',
    ru: 'Камера недоступна — вставьте ссылку ниже.',
  },
  scanPastePrompt: { en: 'No camera? Paste the link', ru: 'Нет камеры? Вставьте ссылку' },
  scanPastePlaceholder: { en: 'paste the invite link…', ru: 'вставьте ссылку-приглашение…' },
  scanJoin: { en: 'Join', ru: 'Войти' },
  scanInvalid: { en: 'That isn’t a valid hushsend link.', ru: 'Это не похоже на ссылку hushsend.' },
  scanQr: { en: 'Scan a QR code', ru: 'Сканировать QR-код' },

  // --- lobby / connecting ---
  creatingTitle: { en: 'Creating session…', ru: 'Создаём сессию…' },
  joiningTitle: { en: 'Joining…', ru: 'Подключаемся…' },
  lobbyEyebrow: { en: 'establishing channel', ru: 'установка канала' },
  lobbyTitle: { en: 'Agreeing on keys…', ru: 'Согласуем ключи…' },
  lobbyDesc: {
    en: 'Your devices set up a shared secret only the two of you hold.',
    ru: 'Устройства создают общий секрет, который есть только у вас двоих.',
  },
  confirmingTitle: { en: 'Verifying…', ru: 'Проверяем…' },
  waitingPeerConfirm: {
    en: 'You confirmed — waiting for your peer to confirm…',
    ru: 'Вы подтвердили — ждём подтверждения собеседника…',
  },

  // --- relax-retry (Max-privacy ICE failure → optional relay escalation, step 6d) ---
  relaxEyebrow: { en: 'direct connection failed', ru: 'прямое соединение не удалось' },
  relaxTitle: { en: "Couldn't connect directly", ru: 'Не удалось соединиться напрямую' },
  relaxDesc: {
    en: 'Route through a relay instead? The relay only carries end-to-end-encrypted bytes (it can’t read them) and your IP stays hidden from your peer — but it is visible to the relay. Both of you must agree before any relay is used.',
    ru: 'Соединиться через relay? Relay передаёт только сквозь-зашифрованные байты (прочитать их он не может), ваш IP скрыт от собеседника — но виден relay. Relay включится только если согласятся обе стороны.',
  },
  relaxAccept: { en: 'Use a relay', ru: 'Через relay' },
  relaxDecline: { en: "Don't relay — cancel", ru: 'Без relay — отмена' },
  relaxPeerReady: {
    en: 'Your peer already agreed to a relay — accept to connect.',
    ru: 'Собеседник уже согласился на relay — примите, чтобы соединиться.',
  },
  relaxWaiting: { en: 'Connecting through a relay…', ru: 'Соединяемся через relay…' },
  relaxWaitingDesc: {
    en: 'Waiting for your peer to agree to the relay too.',
    ru: 'Ждём, пока собеседник тоже согласится на relay.',
  },

  // --- SAS (picker side — joiner is BLIND, identifies the phrase by listening) ---
  sasEyebrow: { en: 'verify over a second channel', ru: 'проверка по второму каналу' },
  sasTitle: { en: 'Which phrase is your peer reading?', ru: 'Какую фразу называет собеседник?' },
  sasDesc: {
    en: 'Listen to the words your peer reads aloud, then pick the matching phrase. No match proves the channel was tampered with.',
    ru: 'Послушайте слова, которые называет собеседник, и выберите совпадающую фразу. Несовпадение означает, что канал подменён.',
  },
  sasConfirm: { en: 'Confirm choice', ru: 'Подтвердить выбор' },
  sasPick: { en: 'Pick the phrase', ru: 'Выберите фразу' },
  sasNone: { en: 'None of these match', ru: 'Ни одна не совпадает' },
  // --- SAS (reader side — creator reads its phrase aloud) ---
  sasYours: { en: 'your phrase — read it aloud', ru: 'ваша фраза — прочитайте вслух' },
  sasReaderTitle: { en: 'Read this phrase aloud', ru: 'Прочитайте фразу вслух' },
  sasReaderDesc: {
    en: 'Say these three words to your peer. They will pick the matching phrase from three options on their screen.',
    ru: 'Назовите эти три слова собеседнику. Он выберет совпадающую фразу из трёх вариантов на своём экране.',
  },
  sasReaderConfirm: { en: 'My peer found it — connect', ru: 'Собеседник нашёл — соединить' },
  sasReaderAbort: { en: "They don't see this phrase", ru: 'Собеседник не видит эту фразу' },
  // --- SAS fail-closed (role could not be resolved — missing id; never a functional blind picker) ---
  sasRestartEyebrow: { en: 'verification interrupted', ru: 'проверка прервана' },
  sasRestartTitle: { en: "Can't verify safely — restart", ru: 'Не удаётся проверить — начните заново' },
  sasRestartDesc: {
    en: 'We could not determine who reads and who listens for this verification (the session lost its peer details). Start over so the check is done safely — do not send files until you do.',
    ru: 'Не удалось определить, кто читает, а кто слушает при этой проверке (сессия потеряла данные собеседника). Начните заново, чтобы проверка прошла безопасно — не передавайте файлы до этого.',
  },
  sasRestartBtn: { en: 'Restart verification', ru: 'Начать проверку заново' },

  // --- transfer ---
  trEyebrow: { en: 'transfer', ru: 'передача' },
  trTitle: { en: 'What are we sending?', ru: 'Что отправляем?' },
  dropTitle: { en: 'Choose files to send', ru: 'Выберите файлы' },
  dropDesc: { en: 'pick one or more from your device', ru: 'выберите один или несколько с устройства' },
  sendBtn: { en: 'Send', ru: 'Отправить' },
  incomingTitle: { en: 'Incoming file', ru: 'Входящий файл' },
  incomingFrom: { en: 'from', ru: 'от' },
  accept: { en: 'Accept', ru: 'Принять' },
  decline: { en: 'Decline', ru: 'Отклонить' },
  awaitAccept: { en: 'Waiting for your peer to accept…', ru: 'Ждём, пока собеседник примет…' },
  plaqueSending: { en: 'Sending over encrypted channel', ru: 'Передача по зашифрованному каналу' },
  plaqueDelivered: { en: 'Delivered', ru: 'Доставлено' },
  plaqueReceived: { en: 'Received', ru: 'Получено' },
  done: { en: 'done', ru: 'готово' },
  cancel: { en: 'Cancel', ru: 'Отмена' },
  newTransfer: { en: 'New transfer', ru: 'Новая передача' },
  closeChannel: { en: 'Close channel', ru: 'Закрыть канал' },
  rejectedLabel: { en: 'declined', ru: 'отклонено' },
  cancelledLabel: { en: 'cancelled', ru: 'отменено' },
  errorLabel: { en: 'transfer error', ru: 'ошибка передачи' },

  // --- failed / error ---
  erMismatchEyebrow: { en: "numbers didn't match", ru: 'не совпало' },
  erMismatchTitle: { en: 'This channel may be compromised', ru: 'Канал может быть скомпрометирован' },
  erMismatchDesc: {
    en: "The phrase you confirmed doesn't match your peer's. Someone may be intercepting — don't send files.",
    ru: 'Подтверждённая фраза не совпала с фразой собеседника. Кто-то может перехватывать — не передавайте файлы.',
  },
  exEyebrow: { en: 'error · room not found', ru: 'ошибка · комната не найдена' },
  exTitle: { en: 'Room not found or code expired', ru: 'Комната не найдена или код истёк' },
  exDesc: {
    en: 'No active room has this code, or it has already expired. Check the digits or start your own room.',
    ru: 'Нет активной комнаты с таким кодом, либо он уже истёк. Проверьте цифры или создайте свою комнату.',
  },
  erGenericEyebrow: { en: 'connection failed', ru: 'соединение не удалось' },
  erGenericTitle: { en: "Couldn't connect", ru: 'Не удалось соединиться' },
  tryAgain: { en: 'Try again', ru: 'Ещё раз' },
  newWords: { en: 'New words', ru: 'Новые слова' },
  backHome: { en: 'Back home', ru: 'На главную' },

  // --- key changed ---
  kcEyebrow: { en: 'device key changed', ru: 'ключ устройства изменился' },
  kcTitle: { en: "This device's key changed", ru: 'Ключ этого устройства изменился' },
  kcDesc: {
    en: 'The signature no longer matches the key we pinned. Your peer may have reinstalled or switched devices — or someone is impersonating them. Do not send files until you re-verify out of band.',
    ru: 'Подпись больше не совпадает с запиненным ключом. Возможно, собеседник переустановил приложение или сменил устройство — либо кто-то выдаёт себя за него. Не передавайте файлы, пока не сверитесь по второму каналу.',
  },
  kcAbort: { en: "Don't connect", ru: 'Не соединяться' },

  // --- session end ---
  reset: { en: 'Done', ru: 'Готово' },
  forgetPins: { en: 'Forget pinned devices', ru: 'Забыть устройства' },
} as const satisfies Record<string, Entry>;

export type StrKey = keyof typeof STR;

export function translate(key: StrKey, lang: Lang): string {
  return STR[key][lang];
}
