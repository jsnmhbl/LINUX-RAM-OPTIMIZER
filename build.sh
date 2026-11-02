#!/usr/bin/env bash
# Bouwt de RAM Optimizer AppImage.
#
# Let op: electron-builder loopt omhoog naar de package.json in je homemap
# (die heeft workspaces) en faalt dan. Daarom bouwen we in een geïsoleerde
# staging-map buiten je homemap.
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
STAGE="${TMPDIR:-/tmp}/ram-optimizer-build"

echo "→ staging naar $STAGE"
# node_modules blijft staan zodat we niet elke keer 230 MB Electron
# opnieuw downloaden.
mkdir -p "$STAGE"
rm -rf "$STAGE/src" "$STAGE/build" "$STAGE/package.json"
cp -r "$PROJ/src" "$PROJ/build" "$PROJ/package.json" "$STAGE/"

cd "$STAGE"
if [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund --prefer-offline --no-save electron@45.2.1 electron-builder@26.18.0 >/dev/null
  node node_modules/electron/install.js
fi

echo "→ bouwen"
npx electron-builder --linux AppImage

APPIMAGE=$(find "$STAGE/dist" -maxdepth 1 -name '*.AppImage' | head -1)
mkdir -p "$HOME/AppImages"
cp "$APPIMAGE" "$HOME/AppImages/RAM-Optimizer.AppImage"
chmod +x "$HOME/AppImages/RAM-Optimizer.AppImage"
echo "→ klaar: $HOME/AppImages/RAM-Optimizer.AppImage"
