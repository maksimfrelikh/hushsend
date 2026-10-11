#!/usr/bin/env node
// Documentation drift checks — run in CI (`npm run docs:check`) and before committing doc changes.
//
// Every tracked Markdown file is checked for:
//   1. size — no file over MAX_LINES lines: one topic per file, so a file that big is several topics;
//   2. links — a relative link must name a file or directory that exists, and a #fragment must match
//      a heading of the target;
//   3. section references — prose pointers such as "THREATMODEL.md § 3" or "§ File transfer" must name
//      a heading that exists in that file (the same file when none is named): moving or renaming a
//      section without updating its pointers is the drift this catches. In the dated records only the
//      file has to exist — they may point at a sub-item of a document as it was then;
//   4. code paths — `src/…`, `tests/…`, `deploy/…` (and the like) quoted in a LIVING document must
//      exist. The append-only records (docs/history/, docs/test-runs/) are exempt: they describe the
//      tree as it was on their date.
//
// Exit status 0 when clean, 1 with one line per problem. No dependencies beyond Node itself.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const MAX_LINES = 500;
const RECORDS = ['docs/history/', 'docs/test-runs/'];
const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const files = execSync("git ls-files '*.md'", { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
// Short names the prose uses for the root documents ("BACKLOG § Deferred", "DEPLOY.md § 0").
const ALIASES = {
  CLAUDE: 'CLAUDE.md', BACKLOG: 'BACKLOG.md', TESTPLAN: 'TESTPLAN.md', THREATMODEL: 'THREATMODEL.md',
  README: 'README.md', COMPATIBILITY: 'COMPATIBILITY.md', DEPLOY: 'deploy/DEPLOY.md',
};
const problems = [];
const report = (file, line, msg) => problems.push(`${file}:${line}: ${msg}`);

const cache = new Map();
function load(file) {
  if (!cache.has(file)) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    const prose = []; // [lineNo, text] outside fenced code, inline code blanked out
    const headings = [];
    let fence = false;
    lines.forEach((text, i) => {
      if (/^\s*```/.test(text)) { fence = !fence; return; }
      if (fence) return;
      const h = /^#{1,6}\s+(.*)$/.exec(text);
      if (h) headings.push(h[1]);
      prose.push([i + 1, text]);
    });
    cache.set(file, { lines, prose, headings });
  }
  return cache.get(file);
}
// GitHub's anchor slug: lower-case, drop everything but letters, digits, spaces, hyphens; spaces → '-'.
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
// A heading or reference reduced to comparable words.
const words = (s) => s.toLowerCase().replace(/[*_`"“”‘’]/g, '').replace(/[^\p{L}\p{N}.+/ -]/gu, ' ')
  .replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();

// Does TARGET have the section the prose names? The name ends where the sentence goes on; a number
// ("§ 3", "§ 0.1", "§ 6e") must start a heading; a TESTPLAN case id ("§ C4") must be a case.
function sectionExists(target, prose) {
  const { headings, lines } = load(target);
  const hs = headings.map(words);
  // a heading's short name is its text before a parenthesis or a dash: "QR (built …)" → "qr"
  const shorts = headings.map((h) => words(h.split(/ \(| — | – | - /)[0]));
  const ref = words(prose.split(/ →|->|[,;:()[\]"“]|['’]s\b| — | – |\. |\.$|\*\*| and | or | \/ /)[0]).replace(/[.\s]+$/, '');
  if (!ref) return true;
  const num = /^(\d+(?:\.\d+)*[a-z]?)\b/.exec(ref);
  if (num) return hs.some((h) => h === num[1] || h.startsWith(num[1] + ' ') || h.startsWith(num[1] + '.'));
  const caseId = /^([a-f]\d+[a-z]?)\b/i.exec(ref);
  if (caseId && target === 'TESTPLAN.md') return lines.some((l) => l.includes(`**${caseId[1].toUpperCase()} `));
  const first2 = ref.split(' ').slice(0, 2).join(' ');
  return hs.some((h, i) => h.startsWith(ref) || ref.startsWith(h) || (first2.includes(' ') && h.startsWith(first2))
    || ref === shorts[i] || ref.startsWith(shorts[i] + ' '));
}

const isRecord = (f) => RECORDS.some((p) => f.startsWith(p));
const inRepo = (p) => existsSync(join(ROOT, p));

for (const file of files) {
  const { lines, prose } = load(file);
  if (lines.length > MAX_LINES) report(file, 1, `${lines.length} lines — over ${MAX_LINES}: split it by topic`);
  const here = dirname(file);
  const slugs = (f) => new Set(load(f).headings.map(slug));

  for (const [n, raw] of prose) {
    const text = raw.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)); // inline code is not prose

    // 2. links
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, frag] = target.split('#');
      const resolved = path ? normalize(join(here, path)) : file;
      if (path && !inRepo(resolved)) { report(file, n, `link to a missing file: ${target}`); continue; }
      if (frag && resolved.endsWith('.md') && !slugs(resolved).has(frag.toLowerCase())) {
        report(file, n, `link to a missing heading: ${target}`);
      }
    }

    // 3. section references: "FILE.md § Heading", "ALIAS § Heading", or a bare "§ Heading" — which means
    //    the file named last on the same line, or this file when none is. The file name may be a link
    //    ([X.md](…)) or inline code (`X.md`); other inline code is not prose.
    const refText = raw
      .replace(/\[[^\]]*\]\(([\w./-]+\.md)(?:#[^)]*)?\)/g, (m, target) => normalize(join(here, target)) + ' '.repeat(Math.max(0, m.length - normalize(join(here, target)).length)))
      .replace(/`([\w./-]+\.md)`/g, '$1 ')
      .replace(/`[^`]*`/g, (m) => '\uE000'.repeat(m.length));
    let lastNamed = null;
    let lastEnd = -1;
    const REF = /(?:([\w./-]+\.md)|\b(CLAUDE|BACKLOG|TESTPLAN|THREATMODEL|README|COMPATIBILITY|DEPLOY))?(?:['’]s)?[ \t]*§[ \t]*([^\n§]+)/g;
    for (let m; (m = REF.exec(refText)); ) {
      const lead = refText.slice(Math.max(0, m.index - 12), m.index);
      if (/RFC\s*\d+\s*$/i.test(lead) || /\uE000\s*$/.test(lead)) continue; // an RFC's section, or a code file's
      let named = m[1] ?? (m[2] && ALIASES[m[2]]);
      // a bare "§ X" right after "FILE § Y and" / "FILE § Y," continues that file; otherwise it means this file
      if (!named && lastNamed && /^[\s,;&/]*(and|or)?[\s,;&/]*$/.test(refText.slice(lastEnd, m.index))) named = lastNamed;
      let target = file;
      if (named) {
        const candidates = [named, normalize(join(here, named)), ALIASES[named.replace(/\.md$/, '')]].filter(Boolean);
        target = candidates.find((c) => inRepo(c) && statSync(join(ROOT, c)).isFile());
        if (!target) { report(file, n, `section reference to a missing file: ${named} § …`); continue; }
        lastNamed = named;
      }
      const nameText = m[3].split(/ →|->|[,;:()[\]"“]|['’]s\b| — | – |\. |\.$|\*\*| and | or | \/ /)[0];
      lastEnd = m.index + m[0].length - m[3].length + nameText.length;
      REF.lastIndex = Math.max(lastEnd, m.index + 1); // the prose after the name may name the next file
      if (!isRecord(file) && !sectionExists(target, m[3])) {
        report(file, n, `section reference to a missing heading: ${target} § ${m[3].trim().slice(0, 60)}`);
      }
    }

    // 4. code paths in living documents
    if (!isRecord(file)) {
      for (const m of raw.matchAll(/`((?:src|tests|deploy|public|visual|scripts|docs|\.github)\/[^`\s*{}<>]*)`/g)) {
        const p = m[1].replace(/:\d+(-\d+)?$/, '').replace(/[.,;)]+$/, '');
        let top = n - 1; // the paragraph this line belongs to
        while (top > 0 && n - top < 8 && lines[top - 1].trim() !== '') top--;
        const before = lines.slice(top, n - 1).join(' ') + ' ' + raw.slice(0, m.index);
        if (/hush-signaling-server|hushsend-stun-server/.test(before)) continue; // a sibling repo's path
        if (!inRepo(p)) report(file, n, `path that does not exist: ${m[1]}`);
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} documentation problem(s).`);
  process.exit(1);
}
console.log(`docs: ${files.length} Markdown files — sizes, links, section references and code paths OK`);
