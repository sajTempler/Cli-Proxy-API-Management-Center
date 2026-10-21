#!/usr/bin/env bash
# Build the panel and install it where the local CLIProxyAPI serves it from.
# The proxy reads management.html from disk on every request, so no proxy restart is needed.
#   scripts/deploy-local.sh             build, then install
#   SKIP_BUILD=1 scripts/deploy-local.sh   install the existing dist/index.html
#   ROLLBACK=1 scripts/deploy-local.sh     put the previous install (<target>.prev) back
# Overrides: PANEL_TARGET=/path/to/management.html, PANEL_URL=http://host:port/management.html
#
# Before replacing the served file, the current one is kept as <target>.prev. After the
# install, the file on disk and the body served at PANEL_URL must both hash to dist/index.html
# and the URL must answer 200; otherwise <target>.prev is restored and the script exits 1.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${PANEL_TARGET:-/Users/szymon/private/CLIProxyAPI/static/custom/management.html}"
url="${PANEL_URL:-http://127.0.0.1:8317/management.html}"
prev="$target.prev"
cd "$root"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Prints the HTTP status and the body's sha256, separated by a space.
served() {
  local body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' --max-time 15 "$url")" || status="${status:-000}"
  echo "$status $(sha "$body")"
  rm -f "$body"
}

# check <expected sha256>: the file on disk and the served body both match, with a 200.
check() {
  local want="$1" status got
  [ "$(sha "$target")" = "$want" ] || { echo "check: $target does not match" >&2; return 1; }
  read -r status got < <(served)
  [ "$status" = 200 ] || { echo "check: GET $url answered $status" >&2; return 1; }
  [ "$got" = "$want" ] || { echo "check: GET $url served a different file" >&2; return 1; }
}

restore() {
  if [ ! -f "$prev" ]; then
    echo "no rollback copy at $prev; leaving $target as is" >&2
    return 1
  fi
  local tmp="$target.tmp.$$"
  cp "$prev" "$tmp"
  mv -f "$tmp" "$target"
  if check "$(sha "$prev")"; then
    echo "restored $prev -> $target ($(sha "$target" | cut -c1-12))" >&2
  else
    echo "restored $prev, but the served page still fails the check" >&2
    return 1
  fi
}

if [ -n "${ROLLBACK:-}" ]; then
  restore
  exit $?
fi

# Use the bun version pinned in package.json (via mise when the shim has no default).
bun_version="$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' package.json)"
if bun --version >/dev/null 2>&1; then bun=(bun); else bun=(mise exec "bun@$bun_version" -- bun); fi

if [ -z "${SKIP_BUILD:-}" ]; then
  "${bun[@]}" install --frozen-lockfile
  "${bun[@]}" run build
fi

[ -s dist/index.html ] || { echo "dist/index.html is missing or empty" >&2; exit 1; }
want="$(sha dist/index.html)"

mkdir -p "$(dirname "$target")"
# Keep the page being served as the rollback copy, unless it already is this build.
if [ -f "$target" ] && [ "$(sha "$target")" != "$want" ]; then
  cp -p "$target" "$prev"
fi
tmp="$target.tmp.$$"
cp dist/index.html "$tmp"
mv -f "$tmp" "$target"

if ! check "$want"; then
  echo "deploy check failed; rolling back" >&2
  restore || true
  exit 1
fi
echo "installed $(git rev-parse --short HEAD) -> $target ($(echo "$want" | cut -c1-12)), GET $url 200"
