# Frelikh Design System

A strictly **monochrome** personal-brand system, reverse-engineered from the
production site of **Maksim Frelikh**, a frontend engineer. The system powers
his portfolio across two domains and is the foundation for building new products
in the same visual language.

- **frelikh.com** — English, light + dark themes
- **maksimfrelikh.ru** — Russian twin, same system

The defining decision is the **absence of an accent color**. Black, white and a
handful of greys carry the entire system — structure, hierarchy and emphasis come
from type weight, scale, hairlines and inversion, never from hue. This is
intentional, not an omission.

> Sources: the values here were distilled from the production `src/styles/app.css`
> and client scripts (Astro project, no UI framework, vanilla JS) plus reference
> screenshots of every state (both themes, both languages, all sections, the ⌘K
> palette and the resume modal). There is a dev-only "directions" sandbox in the
> original CSS (`data-dir`, `data-layout`, `data-aside`…) — it is **not** part of
> the system. The canonical production configuration is:
> `<html data-dir="swiss" data-layout="bisect" data-theme="dark" data-aside="feature" data-cmdk="on">`.
>
> Repo: <https://github.com/maksimfrelikh/frelikh-design> — the public design repo
> for the brand. Explore it (and the production site at frelikh.com /
> maksimfrelikh.ru) to do a more faithful job building in this language.

---

## Content fundamentals

- **Voice.** First person, plainspoken, engineer-to-engineer. Confident but never
  salesy. Copy reads like notes from someone who ships: *"A PR that copied server
  data into a Redux slice, the stale bug it caused, and when RTK still earns its
  place."* Article titles state a claim and a tension, not a topic.
- **Person.** "I" for the author, "you" for the reader. Bios are terse and
  metric-bearing: *"-25% initial JS bundle"*, *"4,000+ paying users"*.
- **Casing.** Sentence case for prose and pill labels. **UPPERCASE mono** for
  eyebrows, section labels, meta and skill-ledger keys (`FRONTEND`, `OPEN TO
  COLLABORATION`), tracked at `0.12em`.
- **Bilingual.** RU and EN are first-class. Russian runs ~30% longer — leave slack.
  Normative Russian em-dashes are kept (they are correct typography, not an
  "AI tell"). Language is served by domain; the toggle crosses to the twin origin.
- **No emoji.** Ever. No exclamation-mark energy. Punctuation is restrained.
- **Numbers earn their place.** A figure appears only when it proves something
  (commit count, bundle delta, conversion). No decorative stats.

---

## Visual foundations

- **Color.** Monochrome, two live themes. Dark is the production default
  (`--bg #000`, `--fg #f2f2f2`); light is the toggle target (`--bg #fff`,
  `--fg #0b0b0b`). Greys step down in three rungs: `--muted` → `--faint` →
  hairlines (`--line`, `--line-2`). Inverse and translucent fills are built with
  `color-mix(in srgb, var(--fg) N%, transparent)` so they adapt to the active
  theme automatically. No gradients, no shadows anywhere — the site is flat and
  separation is held entirely by hairlines (no `box-shadow`, including on the
  modal and ⌘K palette). `--ink`/`--ink-fg` is the one "inverted block" pair used
  for hover fills and `::selection`.
- **Type.** Grotesk for everything (`Archivo`, with `Onest` covering Cyrillic and a
  metric-matched `Archivo Fallback` against CLS); `IBM Plex Mono` for labels, meta
  and code. Display weight is 600; body is 400. Hierarchy is built from a fluid
  `clamp()` scale (`--t-mega … --t-meta`) multiplied by `--scale`. Headings are
  tight (`letter-spacing -0.02…-0.035em`, balanced wrap); article measure is frozen
  at `--measure: 36.672rem` (≈64ch) — narrow text, wide media.
- **Layout.** Centered `--maxw: 1200px` container with fluid `--gut`. The canonical
  **bisect** layout splits each section into two columns divided by a central
  hairline, with the section heading sticky in the left column. Sections are
  separated by a single `border-top: 1px solid var(--line)` (the first has none).
- **Backgrounds.** Flat — pure `--bg`. No imagery behind content, no texture, no
  pattern. The only "image" surfaces are the speaker photo and the GitHub graph.
  Image placeholders use a subtle diagonal hairline stripe with a mono caption.
- **Borders & radii.** Hairlines do the structural work. One radius scale:
  `--r-xs 2px` (chips/ring) · `--r-sm 6px` (inputs/chips) · `--r-md 10px`
  (cards/modals) · `--r-pill 999px` (pills) · `--r-circle`.
- **Cards.** There are barely any "cards" — content sits directly on the page,
  divided by hairlines. The few boxed surfaces (⌘K palette, resume modal) get
  `--r-md` and a `--line-2` border — no shadow. Nothing floats; the header only
  grows a bottom hairline after `scrollY > 8`.
- **Motion.** Two curves, three durations (see `tokens/motion.css`).
  `--ease-out` (cubic-bezier(.22,1,.36,1)) for anything that moves; `--ease-soft`
  (`ease`) for pure fades. `--dur-fast 120ms` / `--dur-base 160ms` /
  `--dur-slow 280ms`. Signature animations: the **ink underline** that flows
  left→right on hover; the **availability pulse** (transform halo); the **copy-icon
  3D flip**; the **theme toggle** 180° rotation; the **GitHub graph** wave reveal.
- **Hover / press.** Pills and the CV button invert to the `--ink` fill on hover.
  Text links grow an ink underline. All hover rules are wrapped in
  `@media (hover: hover)` so touch never gets a stuck state. Focus shows a
  `2px solid var(--fg)` ring with offset; mouse focus is clean.
- **Accessibility is a system priority.** Monochrome but contrast-correct;
  `prefers-contrast: more` lifts greys to AAA. Focus ring + skip link + `.sr-only`,
  focus-trap in overlays, ≥44px touch targets on coarse pointers,
  `scroll-padding-top` for sticky-header anchors, and a full
  `prefers-reduced-motion` reset.

---

## Iconography

Icons are **inline SVG only, stroke-based, on `currentColor`** — no icon fonts,
no `<img>`, no Unicode/emoji glyphs (on iOS Safari those render as colour emoji and
ignore the theme). There are deliberately **no brand logos** for contacts;
GitHub / Telegram / LinkedIn are shown as text + a trailing arrow.

Meaning is kept distinct:
- **`↗` ArrowNe** — "opens an external tab". `viewBox 0 0 10 10`, stroke 1.4,
  rounded caps, sized ~`0.82em`. Used in contact pills and external links.
- **`⧉ → ✓` CopyIcon** — "click copies". Two-layer glyph that flips in place;
  degrades to a crossfade under reduced-motion. Used in copy-email / copy-link.
- **Theme toggle** — a half-filled circle (light/dark metaphor) that rotates 180°.
- **Burger** — two strokes that morph into an X (mobile only).

See `components/icons/` for the React implementations and `assets/` for nothing —
all icons live in code, none as files.

---

## Index / manifest

| Path | What |
|---|---|
| `styles.css` | Global entry — `@import`s every token + base file. Consumers link this. |
| `tokens/` | `fonts` · `colors` · `typography` · `spacing` · `radii` · `motion` · `base` |
| `guidelines/` | Foundation specimen cards (Type, Colors, Spacing, Motion) |
| `components/icons/` | `ArrowNe`, `CopyIcon`, `ThemeToggleIcon` |
| `components/buttons/` | `ContactPill`, `CvButton` |
| `components/content/` | `SectionHeader`, `ProjectCard`, `ArticleRow`, `SkillLedger`, `TagList` |
| `ui_kits/personal-site/` | Full interactive recreation — themes, RU/EN, ⌘K, resume modal |
| `templates/personal-site/` | `PersonalSite.dc.html` — copy-to-start portfolio template composing the real tokens + components |
| `SKILL.md` | Agent-Skill manifest for downloading into Claude Code |

**To consume:** link `styles.css`, set `data-theme="dark"` on `<html>` for the
production default, and build with the tokens + components above.
