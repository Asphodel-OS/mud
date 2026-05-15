#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MUD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve consuming repo: prefer game2, fall back to taruchi (legacy name).
if [ -d "$MUD_ROOT/../game2" ]; then
  VENDOR_DIR="$(cd "$MUD_ROOT/../game2" && pwd)/vendor"
elif [ -d "$MUD_ROOT/../taruchi" ]; then
  VENDOR_DIR="$(cd "$MUD_ROOT/../taruchi" && pwd)/vendor"
else
  echo "ERROR: neither ../game2 nor ../taruchi exists relative to $MUD_ROOT" >&2
  exit 1
fi

echo "Building @latticexyz/store-sync..."
cd "$MUD_ROOT/packages/store-sync"
pnpm tsup

echo "Packing tarball..."
pnpm pack

TARBALL="$(ls -1t latticexyz-store-sync-*.tgz | head -1)"
if [ -z "$TARBALL" ]; then
  echo "ERROR: no tarball produced" >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"
mv "$TARBALL" "$VENDOR_DIR/$TARBALL"

echo "Vendored to $VENDOR_DIR/$TARBALL"
echo "Run 'pnpm install' in the consuming repo to pick up the change."
