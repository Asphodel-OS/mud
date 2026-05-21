#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MUD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -d "$MUD_ROOT/../game2" ]; then
  VENDOR_DIR="$(cd "$MUD_ROOT/../game2" && pwd)/vendor"
elif [ -d "$MUD_ROOT/../taruchi" ]; then
  VENDOR_DIR="$(cd "$MUD_ROOT/../taruchi" && pwd)/vendor"
elif [ -d "$MUD_ROOT/../prolog" ]; then
  VENDOR_DIR="$(cd "$MUD_ROOT/../prolog" && pwd)/vendor"
else
  echo "ERROR: neither ../game2 nor ../taruchi exists relative to $MUD_ROOT" >&2
  exit 1
fi

echo "Building @latticexyz/store-indexer..."
cd "$MUD_ROOT/packages/store-indexer"
pnpm tsup --no-dts

echo "Packing tarball..."
cd "$MUD_ROOT/packages/store-indexer"
pnpm pack

TARBALL="$(ls -1t latticexyz-store-indexer-*.tgz | head -1)"
if [ -z "$TARBALL" ]; then
  echo "ERROR: no tarball produced" >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"
mv "$TARBALL" "$VENDOR_DIR/$TARBALL"

echo "Vendored to $VENDOR_DIR/$TARBALL"
echo "Run 'pnpm install' in taruchi to pick up the change."
