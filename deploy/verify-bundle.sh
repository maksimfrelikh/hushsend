#!/usr/bin/env bash
#
# Check that a LIVE hushsend deployment is serving exactly the bytes an independent build produced.
#
#   bash deploy/verify-bundle.sh --manifest <file|URL> [--base https://hushsend.frelikh.dev]
#   bash deploy/verify-bundle.sh                      # no manifest: just print what is being served
#
# WHY THIS EXISTS, and what it does NOT do.
#
# THREATMODEL.md ranks code delivery as the dominant risk: the server the threat model declares
# untrusted is the same server that hands you the JavaScript, so an operator who is compromised or
# compelled can serve a modified bundle — to one IP if they like — and every other guarantee in the
# product becomes theatre. Neither CSP nor SRI helps, because the same server emits both.
#
# Hashes published by a DIFFERENT party (the CI build, attested by GitHub — see
# .github/workflows/ci.yml) change what that attack costs, but be precise about how:
#
#   - It does NOT protect the person running it at the moment they load the page. A browser that was
#     already served a hostile bundle has already lost; checking afterwards from the same machine is
#     shutting the door behind you.
#   - It DOES remove "silently". The operator can no longer swap the bundle without the swap being
#     detectable by anyone who looks — a mirror, a journalist's technical contact, a watchdog running
#     this on a schedule from somewhere unrelated. Targeted tampering (bad bytes to one IP only) is
#     caught only if someone checks FROM that vantage point, which is an argument for several people
#     checking from several networks, not for checking once.
#   - It is the precondition for the stronger forms — an extension or a desktop build shipped through
#     a store, or an independent mirror — none of which can be verified without a reference hash.
#
# Exit status: 0 all files match, 1 a mismatch (LOUD — this is the interesting case), 2 usage/fetch
# error. Needs only curl + sha256sum.
set -euo pipefail

BASE="https://hushsend.frelikh.dev"
MANIFEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base needs a URL}"; shift 2 ;;
    --manifest) MANIFEST="${2:?--manifest needs a file or URL}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "verify-bundle: unknown argument: $1" >&2; exit 2 ;;
  esac
done
BASE="${BASE%/}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # fetch <url> <dest> — fail loudly rather than hashing an error page
  local code
  code="$(curl -fsSL --max-time 60 -o "$2" -w '%{http_code}' "$1" 2>/dev/null)" || {
    echo "  ✗ FETCH FAILED  $1" >&2
    return 1
  }
  [ "$code" = "200" ] || { echo "  ✗ HTTP $code    $1" >&2; return 1; }
}

# Which files to check. With a manifest we check EXACTLY what it names — that also covers files no
# amount of HTML parsing would find, such as the lazily-fetched QR-decoder .wasm, whose path only
# appears inside the JavaScript.
if [ -n "$MANIFEST" ]; then
  case "$MANIFEST" in
    http://*|https://*) fetch "$MANIFEST" "$TMP/manifest.txt" || exit 2 ;;
    *) cp "$MANIFEST" "$TMP/manifest.txt" || exit 2 ;;
  esac
  PATHS="$(awk '{print $2}' "$TMP/manifest.txt")"
else
  # No manifest: discover what index.html references, so the command is still useful for a quick look.
  fetch "$BASE/" "$TMP/index.html" || exit 2
  PATHS="index.html
$(grep -oE '(src|href)="/[^"]+"' "$TMP/index.html" | sed 's/.*="\///;s/"$//' | LC_ALL=C sort -u)"
fi

echo "verifying $BASE"
[ -n "$MANIFEST" ] && echo "against   $MANIFEST"
echo

fail=0
missing=0
: > "$TMP/actual.txt"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$TMP/dl/$(dirname "$rel")"
  # index.html is served at "/" (try_files → /index.html); everything else at its own path.
  url="$BASE/$rel"
  [ "$rel" = "index.html" ] && url="$BASE/"
  if ! fetch "$url" "$TMP/dl/$rel"; then
    missing=$((missing + 1))
    continue
  fi
  got="$(sha256sum "$TMP/dl/$rel" | cut -d' ' -f1)"
  printf '%s  %s\n' "$got" "$rel" >> "$TMP/actual.txt"
  if [ -n "$MANIFEST" ]; then
    want="$(awk -v p="$rel" '$2 == p {print $1}' "$TMP/manifest.txt")"
    if [ -z "$want" ]; then
      printf '  ? %s  (not in manifest)\n' "$rel"
    elif [ "$want" = "$got" ]; then
      printf '  ✓ %s\n' "$rel"
    else
      printf '  ✗ %s\n      expected %s\n      served   %s\n' "$rel" "$want" "$got"
      fail=$((fail + 1))
    fi
  else
    printf '  %s  %s\n' "$got" "$rel"
  fi
done <<EOT
$PATHS
EOT

echo
if [ -z "$MANIFEST" ]; then
  echo "No manifest given — nothing was verified, the hashes above are just what is being served."
  echo "Get a reference from the CI build of the commit you expect, then re-run with --manifest."
  exit 0
fi
if [ "$missing" -gt 0 ]; then
  echo "✗ $missing file(s) in the manifest could not be fetched — treat this as a FAILED check."
  exit 1
fi
if [ "$fail" -gt 0 ]; then
  echo "✗ MISMATCH: $fail file(s) differ from the independently built manifest."
  echo "  This is the case the check exists for. It does NOT prove malice — a stale deploy looks the"
  echo "  same — so establish WHICH commit the host last deployed before drawing a conclusion."
  exit 1
fi
echo "✓ every file matches the independently built manifest."
echo "  Scope: these bytes, fetched from here, now. It says nothing about what another client is"
echo "  served, or about a build whose SOURCE was already modified — for that, check the attestation"
echo "  (gh attestation verify) and read the commit."
