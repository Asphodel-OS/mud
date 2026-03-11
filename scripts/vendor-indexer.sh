#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MUD_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$(cd "$MUD_ROOT/../taruchi" && pwd)/vendor"

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
