#!/usr/bin/env bash
# Build Linux installers and normalize Tauri v1's .deb runtime dependencies.
set -euo pipefail

bundle="${1:-${BUNDLE:-deb}}"
case "$bundle" in
  deb) bundles=(deb) ;;
  rpm) bundles=(rpm) ;;
  appimage) bundles=(appimage) ;;
  all) bundles=(deb rpm appimage) ;;
  *)
    echo "Usage: bash packaging/build-linux.sh [deb|rpm|appimage|all]" >&2
    exit 2
    ;;
esac

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

if [[ "$bundle" == "appimage" || "$bundle" == "all" ]]; then
  if ! command -v patchelf >/dev/null 2>&1; then
    echo "AppImage bundling with GStreamer requires patchelf on PATH." >&2
    exit 1
  fi
  export APPIMAGE_BUNDLE_GSTREAMER=1
fi

pnpm tauri build --bundles "${bundles[@]}"

if [[ "$bundle" == "deb" || "$bundle" == "all" ]]; then
  node scripts/fix-deb-dependencies.mjs src-tauri/target/release/bundle/deb
fi
