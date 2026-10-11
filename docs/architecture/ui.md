# UI / styling — stark-ui-kit (required)

Part of the architecture reference — [README.md](README.md) is the index.

Dependency: `"stark-ui-kit": "github:maksimfrelikh/stark-ui-kit#<sha>"` — a public GitHub repo, pinned by
commit (NOT on the npm registry: `npm install stark-ui-kit` fetches an unrelated package). **Current pin:
`f9d9250` = kit 0.3.2** (since 2026-10-03 — quiet touch feedback, § UI → *Touch press*); every consumer's
pin is in the consumers table of the kit's own `CLAUDE.md`. Bumping the pin needs `npm install`
with the TPM SSH agent (`SSH_AUTH_SOCK=/run/user/1000/ssh-tpm-agent.sock` in a non-interactive shell) —
npm caches a git dep by sha, so the bump IS the install. The rules for changing the kit and how a change
travels live in the kit's own `CLAUDE.md`; its `README.md` is the consumer contract.
- **The reference is the Claude Design canvas** https://claude.ai/artifact/XRjdVX5U8SC8m2cDSgzDSP
  (implemented 2026-09-26). Read it with the Artifact tool: `project/canvas.json` places the boards,
  `project/<Name>.dc.html` is one board (Main, HomeEmpty, Method, Share, Scan*, WordsRead*, WordsEnter*,
  Lobby*, SasReader*, SasPicker, Connecting, ReconnectWait, Transfer*, Failed*, KeyChanged; Dark /
  Desktop / Tablet / Stress / Zoom suffixes are the same screens at other themes and widths),
  `Components` names the kit token for every element, `Checks` is the per-screen WCAG 2.2 AA table.
  **Take composition, hierarchy, states and copy from the boards; take every VALUE (colour, type,
  spacing rhythm, radius, motion) from the kit's tokens, never from the artboards** (kit rule 6).
  The old HTML prototype that used to live under `uploads/design-reference/` was DELETED on
  2026-09-26 (with its drifted `_ds/` token copy) — the canvas is the only reference.
- **Design language = "Stark"**, published as a Claude Design system generated from the reference site
  frelikh.com: https://claude.ai/artifact/Da7if9WhD7hxZjf5sL6m2F (brand book, tokens, kit + site
  components). Values come from the kit, never from there either.
- **Imports, in this order, once, at the app root (`src/main.tsx`):** the two webfonts
  (`@fontsource-variable/archivo/wght.css`, `@fontsource/ibm-plex-mono/{400,500,600}.css` — the
  families `theme-mono.css` names, self-hosted through the bundle because the CSP allows `font-src
  'self'` only), `stark-ui-kit/styles.css` (tokens + a11y base), `stark-ui-kit/theme-mono.css` (the house
  palette — the ONLY source of every `--brand-*` value; **this app declares none of its own**), the
  three kit component stylesheets the screens adopt — `controls.css` (`.pill`: the lozenge and its ink
  inversion on hover / press; the app's `.hs-pill` adds the boards' geometry on top), `theme-toggle.css`
  (`.theme-toggle`, the half-filled circle; `app.css` sets `--theme-toggle-flip: 180deg` on
  `[data-theme="light"]` and the button keeps `aria-pressed` = light active), `layout.css` (`.wrap`: the
  column — its `padding-inline: var(--gut)` IS the design's 20 / 34 / 72 gutter at 375 / 680 / 1440;
  `.hs-main` sets `--maxw` to `calc(520px + 2 * var(--gut))` — the design's 520px column of CONTENT with the
  gutter outside it; `.wrap` is a border-box, so a bare `520px` had put the gutters inside and left 376px at
  1440 / 452px at 680 until 2026-10-03) — then `src/ui/app.css` (the app
  component layer). A colour or font value is changed in the kit and arrives here by a pin bump, never
  by an override in this repo. `links.css`, `lang-switch.css`, `prose.css`, `command-palette.css` are
  not imported (nothing renders them). Nothing was promoted INTO the kit (kit rule 5: two consumers).
- **Strictly MONOCHROME — there is NO accent colour, no shadow, no gradient, no illustration.**
  Emphasis / selected / danger is the single ink-INVERSION language: `--ink` on `--ink-fg`. The
  key-changed hard stop inverts the WHOLE viewport (`.hs-app--inverted` re-reads every semantic token
  from a swapped set). Do not add any colour/accent token, ever.
- **Theme is switched via `[data-theme]` on `<html>`.** `index.html` ships `data-theme="light"` on
  `<html>` so the first paint is light; `prefs.tsx` then reflects the stored choice (`hushsend.theme`,
  default light) from an effect. The attribute must stay in `index.html`: `theme-mono.css` follows
  `prefers-color-scheme` only when the attribute is ABSENT, and without it a dark-OS browser would paint
  the pre-hydration frame dark and then cut to light. The switch itself is a CUT — `prefs.tsx` sets
  `data-theme-switching` around the flip and the kit zeroes all transitions for that frame (asserted by
  `visual/tokens.spec.ts`). An OS-following default would need an inline script before the bundle,
  which the CSP (`script-src 'self'`, no inline) forbids — not planned.
- **Values: kit tokens only.** Semantic colours `--bg` / `--fg` / `--muted` / `--faint` / `--line` /
  `--line-2` / `--ink` / `--ink-fg` (+ `--scrim` / `--tap-highlight` / `--scroll-shadow`); radii `--r-*`;
  the fluid type roles `--t-h1/h2/h3/lead/body/meta` — with the two display roles CAPPED for this
  app's ~520px column (`--hs-t-h1: min(var(--t-h1), 3rem)`, `--hs-t-h2: min(var(--t-h2), 2rem)` in
  `app.css`: `--t-h1` is sized for a full-width hero and reaches 73.6px at 1440 where the boards show
  48, so the h1 keeps the role's own 38.4px at 375 and stops at 48px from 1200px up; the h2 stops at
  32px; the rule is "the kit role is the source, the cap says where its curve stops here"), weights
  `--w-*` + the label system `--label-*`; fonts
  `--font-grotesk` / `--font-mono`; rhythm `--gut` / `--maxw`; motion `--ease-*` / `--dur-*`.
  Derived, not invented: the wash behind quiet pills / rows / the file zone is `--fg` at 4 % light /
  9 % dark (`--hs-wash`, the same mixes the kit uses for its focus tint and active row), the inactive
  mode title is `--fg` at 45 %. Three literal display caps are the owner's decisions for 200 % text
  zoom: room code `min(132px, 35vw)`, code words `min(44px, 11.7vw)`, phrase `min(56px, 15vw)`. The
  mode titles are weight **700** (the one weight outside the kit's 600 — the board asks for it, and axe
  counts 19px text as large only when bold). Control geometry (heights, paddings, gaps) is literal px
  following the boards — the kit has no spacing scale. `prefers-contrast: more` is the kit's palette;
  the app carries no contrast overrides.
- **Touch press (2026-10-03, kit 0.3.2):** the KIT owns it — `theme-mono.css` sets the house
  `--brand-tap-highlight: transparent` (iOS painted the fg-10 % highlight across whole rows), and
  `controls.css` gives `.pill` / `.btn` a quiet fg-10 % press with no transition under `(hover: none)` instead
  of the ink inversion (the hover language; on a finger it was a black flash). This app adds nothing of its
  own for touch — the first fix (`ff862a4`, app-level) was folded into the kit the same day. Owner's option (b).
- **Control edges:** `--fg` at rest where the edge alone identifies the control (text inputs, the room
  code input, the five word fields, phrase cards, the file zone); `--line-2` where a label identifies it
  (pills, method / device / peer rows). Focus is the kit's 2px ring; on fields it sits ON the edge
  (offset −1) so the field reads as one thicker line.
- **Screen pacing (owner, 2026-09-28 — do not relitigate):** the four pre-connection states never flash
  a screen. `screens/pacing.ts` (pure, unit-tested) + `usePacedScreen` (in the `Shell`, so the
  key-changed inversion follows the SHOWN screen): when the FSM leaves a screen for `creating` /
  `joining` / `pairing` / `confirming`, that screen is HELD `HOLD_MS` (400) — `<Screen>` gets `inert`
  from the `ScreenBusy` context and every control on it takes the disabled-pill look (app.css "held
  screen"; the pressed SAS card and the checked mode keep their state) — the owner's marker that the
  tap registered and something is happening; if the FSM settles within the hold, the next screen
  replaces it directly. Only a stage that outlasts the hold brings up `ConnectingScreen`, whose stage
  titles stay (owner) but paced: each title ≥ `TITLE_MIN_MS` (500), the screen leaves only after its
  title had that long, a stage over within `STAGE_SETTLE_MS` (150) never gets its title. A hold before
  the app's first frame (a link opened straight into `joining`) is an empty column, not the unseen
  Home. Measured on the live build before the change (2026-09-28, real Chrome, a MutationObserver
  recorder on both sides): a direct pair ran through every stage in 30–215 ms and a relayed one in
  0.3–1.5 s. Live with `273e9e7` (2026-09-29, a LAN that night at ~60 ms to the server, so every
  stage took 2–5× longer): nothing flashed — a run under the hold went from the held screen straight
  to the next one, a longer one showed the Connecting screen for 500–650 ms, and "Verifying…" (2–20 ms
  stages) never appeared. Only the DISPLAY lags: the FSM,
  the store and `data-testid="status"` are untouched, and `connected` is shown only while the status
  is `connected`. Visual scenes that end in a stage wait for the Connecting screen; the held looks are
  the `method-held` / `share-held` / `sas-picker-held` scenes (DEV knob `__HUSHSEND_SCREEN_HOLD_MS__`).
- **Screen set (the decisions taken with the owner — do not relitigate):** base width 375, breakpoints
  680 (top bar 56 → 64, gutter 20 → 34) and 1440 (gutter 72). Link and QR are ONE screen (Share: QR +
  link + Copy + Share); no "Waiting for your peer…" copy anywhere, waiting is implied. Home: h1, the
  Max privacy / Reliable two-word radio group with a one-line description, Invite someone, the room
  code form, Enter code words / Scan a QR code, a Reconnect section (paired devices, per-device
  Reconnect + a per-device × that forgets every pin of that peer — `recentDevices.forgetDevice` — and
  the global "Forget pinned devices"), then "About privacy and security" as collapsible details. Room
  lobby: the 4-digit code is the hero, Copy code, the roster ROWS are the tap targets, the busy reply is
  a one-time notice line above the roster (role=alert). Code words: read = five numbered mono words,
  the attempt line after a wrong guess, NO copy button (spoken, never pasted); enter = five fields with
  a listbox of up to three prefix matches on touch and inline completion (Enter / Tab) on pointer,
  "No matching word" under the active field, Connect enabled at five words. SAS reader: the phrase is
  the largest text in the app and the sentence "Only continue once you have HEARD your peer say these
  words back." sits directly above the confirm button (the only gate on this side); picker: three
  phrase cards as buttons with aria-pressed, selected = inversion. Transfer: the only happy-path status
  is the heading "Secure channel open" (the verified text stays in the DOM as sr-only `auth-state`);
  the path check renders as disclosure rows ONLY in the non-ok states ("direct path not confirmed"
  muted, "route did not match" and "address servers disagree" fg + glyph, each opening its hint); one
  transfer = one row, one progress bar, one Cancel; delivered / declined / cancelled / error in the same
  container, then "New transfer" — on Safari a received file's row also says to answer Safari's own
  download question (`download-prompt-hint`, since 2026-10-11 — transfer.md). Failed is ONE screen with
  variants (compromised, room not found — or, since 2026-10-11, "this link expired or was already used" /
  "these words don't work any more" for those methods, which have no digits to check — nobody came,
  verification interrupted with "Restart verification", direct failed ± relay hint, this browser can't
  send files (no WebRTC), generic, words with "New words"); no "Try again". A browser without WebRTC
  never reaches the app: App.tsx shows the same "This browser can't send files" page instead
  (`NoWebRtcScreen`) and a link opened there is scrubbed but not followed. Header: the existing Wordmark + the kit toggle.
  **SAS refusals — EQUAL WEIGHT (the 2026-09-12 audit decision, restored the same day the redesign
  briefly composed them as a tertiary label):** "Stop — they don't have this phrase" and "None of these
  match — stop" are quiet pills with the SAME geometry as the confirm (the kit's `.pill`, 52px, full
  width) directly under it. A small "stop" biases the human toward confirming, and the confirm is the
  only gate on the reader side — this is the one place the boards are overruled.
- **Language: ENGLISH ONLY for now.** `i18n.ts` keeps the table, `ru` is optional with a fallback to
  `en`, new strings get `en` only, and the header shows no EN|RU switch until the Russian half is
  complete ([BACKLOG.md](../../BACKLOG.md) § Deferred). Copy is the owner's placeholder, taken from the boards as-is.
- For focus-trap, scroll-lock, and copy-to-clipboard use the kit's hooks/utilities — do not reimplement.
  `copyToClipboard` imports from the root `stark-ui-kit` entry (the only kit JS this app uses today);
  `useFocusTrap` / `useScrollLock` live on `stark-ui-kit/react` — import them from there when a screen
  needs them (no dialog exists in the app today).
- **Gates** before a UI change is done — the e2e, the axe gate (`tests/a11y/`) and the screenshot gate
  (`visual/`): [CLAUDE.md](../../CLAUDE.md) § Done means green.
