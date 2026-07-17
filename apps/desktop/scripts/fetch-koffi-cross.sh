#!/bin/bash
# Fetch koffi's NON-HOST platform prebuilds into node_modules.
#
# Why: koffi resolves its native module from per-platform
# @koromix/koffi-<platform>-<arch> packages declared as
# optionalDependencies — and npm only installs the HOST platform's one.
# A Windows or Linux artifact cross-built on the mac therefore ships
# without its koffi binary and crashes at startup with "Cannot find the
# native Koffi module" (field error, 2026-07-16, Windows VM).
#
# electron-builder bundles whatever @koromix/* packages exist in
# node_modules (asarUnpack'd), so materializing them here is the whole
# fix. Versions are pinned to the installed koffi's own version.
# Idempotent; run as part of dist/release (see package.json scripts).
set -euo pipefail
cd "$(dirname "$0")/.."

KOFFI_VERSION=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/koffi/package.json','utf8')).version")

for pkg in koffi-win32-x64 koffi-linux-x64; do
  dest="node_modules/@koromix/$pkg"
  if [ -d "$dest" ]; then
    have=$(node -p "JSON.parse(require('fs').readFileSync('$dest/package.json','utf8')).version" 2>/dev/null || echo none)
    if [ "$have" = "$KOFFI_VERSION" ]; then
      echo "koffi-cross: $pkg@$have present"
      continue
    fi
    rm -rf "$dest"
  fi
  echo "koffi-cross: fetching @koromix/$pkg@$KOFFI_VERSION"
  tmp=$(mktemp -d)
  (cd "$tmp" && npm pack "@koromix/$pkg@$KOFFI_VERSION" --silent >/dev/null && tar -xzf ./*.tgz)
  mkdir -p "$dest"
  cp -R "$tmp/package/." "$dest/"
  rm -rf "$tmp"
done
echo "koffi-cross: done"
