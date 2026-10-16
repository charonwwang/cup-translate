#!/bin/bash
# Development-only ad-hoc signing. Distribution requires Developer ID/notarization.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
    echo 'Local macOS signing must run on macOS.' >&2
    exit 1
fi
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_path="${1:-$repo_root/src-tauri/target/release/bundle/macos/cup-translate.app}"
[[ -d "$app_path/Contents/MacOS" && -f "$app_path/Contents/Info.plist" ]] || exit 1
# Finder metadata can be copied from Desktop resources. Leave all security and
# quarantine attributes intact; never clear extended attributes indiscriminately.
xattr -r -d com.apple.FinderInfo "$app_path" 2>/dev/null || true
xattr -r -d com.apple.ResourceFork "$app_path" 2>/dev/null || true
codesign --force --deep --sign - --identifier com.cup-translate.app "$app_path"
codesign --verify --deep --strict "$app_path"
