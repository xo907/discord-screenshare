#!/usr/bin/env bash
# Compiles node-datachannel's native addon on this machine.
#
# Needed on older OSes (Raspberry Pi OS Bookworm, Ubuntu 22.04): the prebuilt binary that
# npm downloads requires glibc 2.38+. Takes ~10-20 minutes on a Pi 4.
#
#   sudo apt install -y cmake build-essential libssl-dev git
#   npm run build-native
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PKG_DIR="$ROOT/node_modules/@lng2004/node-datachannel"
if [ ! -d "$PKG_DIR" ]; then
  echo "Run 'npm install' first." >&2
  exit 1
fi

# Don't rebuild (and risk losing a working build) unless asked to.
if [ "${1:-}" != "--force" ] && [ -f "$PKG_DIR/build/Release/node_datachannel.node" ] \
  && node -e "import('@lng2004/node-datachannel')" 2>/dev/null; then
  echo "node-datachannel is already built and working. Use 'npm run build-native -- --force' to rebuild."
  exit 0
fi

for tool in cmake g++ make git; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Run: sudo apt install -y cmake build-essential libssl-dev git" >&2; exit 1; }
done
[ -f /usr/include/openssl/ssl.h ] || { echo "Missing OpenSSL headers. Run: sudo apt install -y libssl-dev" >&2; exit 1; }

# Build tools go in a throwaway folder so they don't touch the project's dependencies.
TOOLS_DIR="$(mktemp -d)"
trap 'rm -rf "$TOOLS_DIR" "$PKG_DIR/build-new"' EXIT
echo "Fetching build tools…"
(cd "$TOOLS_DIR" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent cmake-js@7 node-addon-api@7 node-api-headers@1)

# CMakeLists.txt looks for these inside the package's own node_modules.
mkdir -p "$PKG_DIR/node_modules"
rm -rf "$PKG_DIR/node_modules/node-addon-api" "$PKG_DIR/node_modules/node-api-headers"
cp -r "$TOOLS_DIR/node_modules/node-addon-api" "$TOOLS_DIR/node_modules/node-api-headers" "$PKG_DIR/node_modules/"

echo "Compiling (this takes a while on a Pi)…"
cd "$PKG_DIR"
# Build into a separate folder and only swap it in once it succeeds, so
# cancelling halfway never leaves you without a working build.
rm -rf build-new
CMAKE_BUILD_PARALLEL_LEVEL="$(nproc)" "$TOOLS_DIR/node_modules/.bin/cmake-js" build --out build-new
rm -rf build
mv build-new build

echo "Checking it loads…"
cd "$ROOT"
node -e "import('@lng2004/node-datachannel').then(() => console.log('node-datachannel OK'))"
