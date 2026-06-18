/* @ds-bundle: {"format":3,"namespace":"FrelikhDesignSystem_1ce280","components":[{"name":"ContactPill","sourcePath":"components/buttons/ContactPill.jsx"},{"name":"CvButton","sourcePath":"components/buttons/CvButton.jsx"},{"name":"ArticleRow","sourcePath":"components/content/ArticleRow.jsx"},{"name":"ProjectCard","sourcePath":"components/content/ProjectCard.jsx"},{"name":"SectionHeader","sourcePath":"components/content/SectionHeader.jsx"},{"name":"SkillLedger","sourcePath":"components/content/SkillLedger.jsx"},{"name":"TagList","sourcePath":"components/content/TagList.jsx"},{"name":"ArrowNe","sourcePath":"components/icons/ArrowNe.jsx"},{"name":"CopyIcon","sourcePath":"components/icons/CopyIcon.jsx"},{"name":"ThemeToggleIcon","sourcePath":"components/icons/ThemeToggleIcon.jsx"}],"sourceHashes":{"components/buttons/ContactPill.jsx":"43e5db3327d7","components/buttons/CvButton.jsx":"5e98e3b03c4c","components/content/ArticleRow.jsx":"319c4581cb7f","components/content/ProjectCard.jsx":"a437770fe749","components/content/SectionHeader.jsx":"4327ccfa682c","components/content/SkillLedger.jsx":"79cfe0a8773d","components/content/TagList.jsx":"6e3aae5a85c3","components/icons/ArrowNe.jsx":"ddad361f0c6a","components/icons/CopyIcon.jsx":"957e7e775726","components/icons/ThemeToggleIcon.jsx":"4cb48f3c418f"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.FrelikhDesignSystem_1ce280 = window.FrelikhDesignSystem_1ce280 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/content/SectionHeader.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SectionHeader — the large left-column heading for a page section
 * (Projects, Writing, Resume, Contact). In the bisect layout it is
 * sticky to the top of the left column. Optional mono index ("01").
 */
function SectionHeader({
  children,
  index,
  sticky = true,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: sticky ? "sticky" : "static",
      top: "var(--scroll-pad)",
      alignSelf: "start",
      ...style
    }
  }, rest), index != null && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--faint)",
      marginBottom: "0.6em"
    }
  }, index), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "var(--t-h2)",
      fontWeight: "var(--w-display)",
      letterSpacing: "var(--ls-heading)",
      lineHeight: "var(--lh-heading)",
      margin: 0
    }
  }, children));
}
Object.assign(__ds_scope, { SectionHeader });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/SectionHeader.jsx", error: String((e && e.message) || e) }); }

// components/content/SkillLedger.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SkillLedger — the resume skills block: rows of an uppercase mono
 * label (FRONTEND) and a dot-separated value list, divided by hairlines.
 * `rows` = [{ label, items: [] }].
 */
function SkillLedger({
  rows = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: style
  }, rest), rows.map((row, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(120px, 160px) 1fr",
      gap: "clamp(16px, 3vw, 40px)",
      padding: "16px 0",
      borderTop: "1px solid var(--line)",
      alignItems: "baseline"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      fontWeight: "var(--w-strong)",
      letterSpacing: "var(--ls-label)",
      textTransform: "uppercase",
      color: "var(--faint)"
    }
  }, row.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--muted)",
      lineHeight: 1.9
    }
  }, row.items.map((it, j) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: j
  }, j > 0 && /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      margin: "0 0.55em",
      color: "var(--faint)"
    }
  }, "\xB7"), it))))));
}
Object.assign(__ds_scope, { SkillLedger });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/SkillLedger.jsx", error: String((e && e.message) || e) }); }

// components/content/TagList.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * TagList — dot-separated meta line (tech stack, category · read time).
 * Mono, muted, with decorative "·" separators that screen readers skip.
 */
function TagList({
  items = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--muted)",
      ...style
    }
  }, rest), items.map((it, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      margin: "0 0.6em",
      color: "var(--faint)"
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, it))));
}
Object.assign(__ds_scope, { TagList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/TagList.jsx", error: String((e && e.message) || e) }); }

// components/content/ArticleRow.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ArticleRow — a writing-list entry. Left rail: date (mono). Right:
 * title (ink-underline on hover), excerpt, and a category · read-time
 * TagList. The whole row is the link target.
 */
function ArticleRow({
  date,
  title,
  excerpt,
  meta = [],
  href,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("a", _extends({
    href: href,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(90px, 120px) 1fr",
      gap: "clamp(20px, 4vw, 56px)",
      padding: "28px 0",
      borderTop: "1px solid var(--line)",
      textDecoration: "none",
      color: "inherit",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--faint)"
    }
  }, date), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "var(--measure)"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      position: "relative",
      display: "inline",
      fontSize: "var(--t-h3)",
      fontWeight: "var(--w-display)",
      letterSpacing: "var(--ls-heading)",
      lineHeight: "var(--lh-heading)",
      backgroundImage: "linear-gradient(var(--fg), var(--fg))",
      backgroundRepeat: "no-repeat",
      backgroundPosition: "0 100%",
      backgroundSize: hover ? "100% 2px" : "0% 2px",
      transition: "background-size var(--dur-base) var(--ease-out)",
      paddingBottom: "2px"
    }
  }, title), excerpt && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--t-body)",
      color: "var(--muted)",
      lineHeight: "var(--lh-body)",
      margin: "12px 0 14px"
    }
  }, excerpt), meta.length > 0 && /*#__PURE__*/React.createElement(__ds_scope.TagList, {
    items: meta
  })));
}
Object.assign(__ds_scope, { ArticleRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/ArticleRow.jsx", error: String((e && e.message) || e) }); }

// components/icons/ArrowNe.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ArrowNe — the "opens externally / new tab" affordance (↗).
 * Stroke-based, currentColor, sized in em so it tracks the text.
 * Carries an sr-only hint about the new tab when `label` is set.
 */
function ArrowNe({
  size = "0.82em",
  label,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 10 10",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M3 7L7 3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3.6 3H7v3.4"
  })), label ? /*#__PURE__*/React.createElement("span", {
    className: "sr-only"
  }, label) : null);
}
Object.assign(__ds_scope, { ArrowNe });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/icons/ArrowNe.jsx", error: String((e && e.message) || e) }); }

// components/buttons/CvButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * CvButton — the "VIEW CV" pill that opens the resume. Uppercase mono
 * label, pill outline, inverts to --ink on hover (same affordance as
 * ContactPill). Trailing ↗.
 */
function CvButton({
  children = "View CV",
  onClick,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.6em",
      padding: "0.7em 1.2em",
      minHeight: "44px",
      borderRadius: "var(--r-pill)",
      border: "1px solid var(--line-2)",
      background: hover ? "var(--ink)" : "transparent",
      color: hover ? "var(--ink-fg)" : "var(--fg)",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      fontWeight: 600,
      letterSpacing: "var(--ls-label)",
      textTransform: "uppercase",
      cursor: "pointer",
      transition: "background var(--dur-fast) var(--ease-soft), color var(--dur-fast) var(--ease-soft)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", null, children), /*#__PURE__*/React.createElement(__ds_scope.ArrowNe, null));
}
Object.assign(__ds_scope, { CvButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/CvButton.jsx", error: String((e && e.message) || e) }); }

// components/content/ProjectCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ProjectCard — a portfolio entry. Left rail: year + status (mono).
 * Right: title, description, tech TagList, optional "Code ↗" link.
 * Title carries the bare ink-underline hover affordance.
 */
function ProjectCard({
  year,
  status,
  title,
  description,
  tags = [],
  codeHref,
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("article", _extends({
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(90px, 120px) 1fr",
      gap: "clamp(20px, 4vw, 56px)",
      padding: "32px 0",
      borderTop: "1px solid var(--line)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--faint)",
      lineHeight: 1.7
    }
  }, /*#__PURE__*/React.createElement("div", null, year), status && /*#__PURE__*/React.createElement("div", null, status)), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "var(--measure)"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      position: "relative",
      display: "inline-block",
      fontSize: "var(--t-h3)",
      fontWeight: "var(--w-display)",
      letterSpacing: "var(--ls-heading)",
      margin: "0 0 12px",
      paddingBottom: "3px"
    }
  }, title, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      left: 0,
      right: hover ? 0 : "100%",
      bottom: 0,
      height: "2px",
      background: "var(--fg)",
      transition: "right var(--dur-base) var(--ease-out)"
    }
  })), description && /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "var(--t-body)",
      color: "var(--muted)",
      lineHeight: "var(--lh-body)",
      margin: "0 0 16px"
    }
  }, description), tags.length > 0 && /*#__PURE__*/React.createElement(__ds_scope.TagList, {
    items: tags,
    style: {
      marginBottom: "14px"
    }
  }), codeHref && /*#__PURE__*/React.createElement("a", {
    href: codeHref,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.4em",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--t-meta)",
      color: "var(--fg)",
      textDecoration: "none"
    }
  }, "Code ", /*#__PURE__*/React.createElement(__ds_scope.ArrowNe, {
    label: "opens in a new tab"
  }))));
}
Object.assign(__ds_scope, { ProjectCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/content/ProjectCard.jsx", error: String((e && e.message) || e) }); }

// components/icons/CopyIcon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * CopyIcon — two-layer "copy / done" glyph for an in-place 3D flip.
 * `done` flips rotateX between the copy layer (two rounded frames)
 * and the done layer (check). Decorative — pair with an aria-live
 * region that announces "copied" for screen readers.
 * Under reduced-motion the rotation degrades to an opacity crossfade.
 */
function CopyIcon({
  done = false,
  size = "1.1em",
  style,
  ...rest
}) {
  const reduce = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wrap = {
    position: "relative",
    display: "inline-block",
    width: size,
    height: size,
    transformStyle: "preserve-3d",
    transition: reduce ? "none" : "transform var(--dur-slow) var(--ease-out)",
    transform: done && !reduce ? "rotateX(180deg)" : "none",
    ...style
  };
  const layer = extra => ({
    position: "absolute",
    inset: 0,
    backfaceVisibility: "hidden",
    transition: reduce ? "opacity var(--dur-base) var(--ease-soft)" : "none",
    ...extra
  });
  return /*#__PURE__*/React.createElement("span", _extends({
    "aria-hidden": "true",
    style: wrap
  }, rest), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    width: "100%",
    height: "100%",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: layer({
      opacity: reduce ? done ? 0 : 1 : 1
    })
  }, /*#__PURE__*/React.createElement("rect", {
    x: "7",
    y: "7",
    width: "9",
    height: "9",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M4 13V5a2 2 0 0 1 2-2h7"
  })), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 20 20",
    width: "100%",
    height: "100%",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: layer({
      transform: reduce ? "none" : "rotateX(180deg)",
      opacity: reduce ? done ? 1 : 0 : 1
    })
  }, /*#__PURE__*/React.createElement("path", {
    d: "M4 10.5L8 14.5L16 6"
  })));
}
Object.assign(__ds_scope, { CopyIcon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/icons/CopyIcon.jsx", error: String((e && e.message) || e) }); }

// components/buttons/ContactPill.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ContactPill — pill-shaped contact link. Resting state is a thin
 * --line-2 outline; on hover it inverts to the --ink fill with
 * --ink-fg text. Two modes:
 *   variant="external" → trailing ↗ (opens a new tab)
 *   variant="copy"     → trailing ⧉/✓ (copies to clipboard in place)
 */
function ContactPill({
  children,
  href,
  variant = "external",
  copyValue,
  style,
  ...rest
}) {
  const [done, setDone] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const isCopy = variant === "copy";
  const onClick = e => {
    if (!isCopy) return;
    e.preventDefault();
    try {
      navigator.clipboard?.writeText(copyValue || children);
    } catch (_) {}
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5em",
    padding: "0.5em 0.95em",
    minHeight: "40px",
    borderRadius: "var(--r-pill)",
    border: "1px solid var(--line-2)",
    background: hover ? "var(--ink)" : "transparent",
    color: hover ? "var(--ink-fg)" : "var(--fg)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--t-meta)",
    fontWeight: 500,
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transition: "background var(--dur-fast) var(--ease-soft), color var(--dur-fast) var(--ease-soft), border-color var(--dur-fast) var(--ease-soft)",
    ...style
  };
  return /*#__PURE__*/React.createElement("a", _extends({
    href: href,
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    target: isCopy ? undefined : "_blank",
    rel: isCopy ? undefined : "noopener noreferrer",
    style: base
  }, rest), /*#__PURE__*/React.createElement("span", null, children), isCopy ? /*#__PURE__*/React.createElement(__ds_scope.CopyIcon, {
    done: done
  }) : /*#__PURE__*/React.createElement(__ds_scope.ArrowNe, {
    label: "opens in a new tab"
  }));
}
Object.assign(__ds_scope, { ContactPill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/buttons/ContactPill.jsx", error: String((e && e.message) || e) }); }

// components/icons/ThemeToggleIcon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ThemeToggleIcon — half-filled circle, the light/dark metaphor.
 * Rotates 180° on toggle (driven by the `dark` prop). Stroke 1.4,
 * currentColor, 15×15 inside a 16-box.
 */
function ThemeToggleIcon({
  dark = true,
  size = 16,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("svg", _extends({
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    "aria-hidden": "true",
    focusable: "false",
    style: {
      display: "block",
      transition: "transform var(--dur-slow) var(--ease-out)",
      transform: dark ? "rotate(180deg)" : "rotate(0deg)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("circle", {
    cx: "8",
    cy: "8",
    r: "6.3",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 1.7a6.3 6.3 0 0 1 0 12.6z",
    fill: "currentColor"
  }));
}
Object.assign(__ds_scope, { ThemeToggleIcon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/icons/ThemeToggleIcon.jsx", error: String((e && e.message) || e) }); }

__ds_ns.ContactPill = __ds_scope.ContactPill;

__ds_ns.CvButton = __ds_scope.CvButton;

__ds_ns.ArticleRow = __ds_scope.ArticleRow;

__ds_ns.ProjectCard = __ds_scope.ProjectCard;

__ds_ns.SectionHeader = __ds_scope.SectionHeader;

__ds_ns.SkillLedger = __ds_scope.SkillLedger;

__ds_ns.TagList = __ds_scope.TagList;

__ds_ns.ArrowNe = __ds_scope.ArrowNe;

__ds_ns.CopyIcon = __ds_scope.CopyIcon;

__ds_ns.ThemeToggleIcon = __ds_scope.ThemeToggleIcon;

})();
