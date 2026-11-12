#!/usr/bin/env bash
set -euo pipefail

rpm -q cup-translate
links="$(ldd /usr/bin/cup-translate)"
if grep -Fq 'not found' <<< "$links"; then
    printf '%s\n' "$links" >&2
    exit 1
fi
grep -F 'libwebkit2gtk-4.1.so.0' <<< "$links"

export DISPLAY=:99 GDK_BACKEND=x11
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp > /tmp/cup-xvfb.log 2>&1 &
xvfb=$!
app=''
trap 'if [ -n "$app" ]; then kill "$app" 2>/dev/null || true; fi; kill "$xvfb" 2>/dev/null || true' EXIT
for i in {1..20}; do
    [ -S /tmp/.X11-unix/X99 ] && break
    sleep 0.5
done

# Use only the container user's disposable profile. Open settings via the
# loopback IPC entry to require the embedded webview frontend to show a window.
mkdir -p "$HOME/.config/com.cup-translate.app"
printf '{"check_update":false,"clipboard_monitor":false}\n' > "$HOME/.config/com.cup-translate.app/config.json"
/usr/bin/cup-translate > /tmp/cup-start.log 2>&1 &
app=$!
for i in {1..60}; do
    if ! kill -0 "$app" 2>/dev/null; then
        cat /tmp/cup-start.log >&2
        exit 1
    fi
    if curl --fail --silent --max-time 2 http://127.0.0.1:60828/config > /dev/null; then
        break
    fi
    sleep 0.5
done
if ! timeout 30s xdotool search --sync --onlyvisible --name '^Config$'; then
    cat /tmp/cup-start.log >&2
    exit 1
fi
kill -0 "$app"
grep -F 'Start App' /tmp/cup-start.log
echo 'Installed RPM started and displayed the settings window'
