#!/usr/bin/env bash
# Build the panel and install it where the local CLIProxyAPI serves it from.
# The proxy reads management.html from disk on every request, so no proxy restart is needed.
#   scripts/deploy-local.sh             build, then install
#   SKIP_BUILD=1 scripts/deploy-local.sh   install the existing dist/index.html
# Target override: PANEL_TARGET=/path/to/management.html
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${PANEL_TARGET:-/Users/szymon/private/CLIProxyAPI/static/custom/management.html}"
cd "$root"

# Use the bun version pinned in package.json (via mise when the shim has no default).
bun_version="$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' package.json)"
if bun --version >/dev/null 2>&1; then bun=(bun); else bun=(mise exec "bun@$bun_version" -- bun); fi

if [ -z "${SKIP_BUILD:-}" ]; then
  "${bun[@]}" install --frozen-lockfile
  "${bun[@]}" run build
fi

mkdir -p "$(dirname "$target")"
tmp="$target.tmp.$$"
cp dist/index.html "$tmp"
mv -f "$tmp" "$target"
echo "installed $(git rev-parse --short HEAD) -> $target ($(shasum -a 256 "$target" | cut -c1-12))"
