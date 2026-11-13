#!/bin/bash
set -euo pipefail
# Checkout belongs to the host runner; only trust this mounted workspace.
git config --global --add safe.directory "$(pwd)"

node_version=v22.11.0
case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo "Unsupported build host architecture" >&2; exit 1 ;;
esac
wget "https://nodejs.org/dist/$node_version/node-$node_version-linux-$node_arch.tar.xz"
tar -Jxf "node-$node_version-linux-$node_arch.tar.xz"
export PATH="$(pwd)/node-$node_version-linux-$node_arch/bin:$PATH"
npm install -g pnpm@12.10.1

# Docker action inputs are also passed as argv; accept either transport.
INPUT_TARGET="${INPUT_TARGET:-${1:?Rust target is required}}"
INPUT_TOOLCHAIN="${INPUT_TOOLCHAIN:-${2:?Rust toolchain is required}}"
export INPUT_TARGET INPUT_TOOLCHAIN
# Cargo 1.100 changed build-script output layout. The Tauri 1 eSpeak
# embedder uses the layout from 1.99; pin Linux packaging until it is ported.
export RUSTUP_TOOLCHAIN=1.99.1
rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal
rustup target add --toolchain "$RUSTUP_TOOLCHAIN" "$INPUT_TARGET"

# Fail if indexes cannot refresh; do not install from stale cached lists.
rm -rf /var/lib/apt/lists/*
apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update
apt-get install -y --no-install-recommends cmake pkg-config file clang libclang-dev rpm libarchive-tools

if [ "$INPUT_TARGET" = "x86_64-unknown-linux-gnu" ]; then
    apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update
    apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup2.4-dev libayatana-appindicator3-dev librsvg2-dev patchelf gstreamer1.0-plugins-base gstreamer1.0-plugins-good libxdo-dev libxcb1 libxrandr2 libdbus-1-3
elif [ "$INPUT_TARGET" = "i686-unknown-linux-gnu" ]; then
    dpkg --add-architecture i386
    apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update
    apt-get install -y libstdc++6:i386 libgdk-pixbuf2.0-dev:i386 libatomic1:i386 gcc-multilib g++-multilib libwebkit2gtk-4.1-0:i386 libjavascriptcoregtk-4.1-0:i386 libsoup2.4-dev:i386 libssl-dev:i386 libgtk-3-dev:i386 librsvg2-dev:i386 patchelf:i386 libxdo-dev:i386 libxcb1:i386 libxrandr2:i386 libdbus-1-3:i386 libayatana-appindicator3-dev:i386
    export PKG_CONFIG_PATH=/usr/lib/i386-linux-gnu/pkgconfig/:${PKG_CONFIG_PATH:-}
    export PKG_CONFIG_SYSROOT_DIR=/
elif [ "$INPUT_TARGET" = "aarch64-unknown-linux-gnu" ]; then
    dpkg --add-architecture arm64
    apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update
    apt-get install -y libncurses6:arm64 libtinfo6:arm64 linux-libc-dev:arm64 libncursesw6:arm64 libcups2:arm64
    apt-get install -y --no-install-recommends g++-aarch64-linux-gnu libc6-dev-arm64-cross libssl-dev:arm64 libwebkit2gtk-4.1-0:arm64 libjavascriptcoregtk-4.1-0:arm64 libsoup2.4-dev:arm64 libgtk-3-dev:arm64 patchelf:arm64 librsvg2-dev:arm64 libxdo-dev:arm64 libxcb1:arm64 libxrandr2:arm64 libdbus-1-3:arm64 libayatana-appindicator3-dev:arm64
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
    export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
    export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
    export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
    export PKG_CONFIG_ALLOW_CROSS=1
elif [ "$INPUT_TARGET" = "armv7-unknown-linux-gnueabihf" ]; then
    dpkg --add-architecture armhf
    apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update
    apt-get install -y libncurses6:armhf libtinfo6:armhf linux-libc-dev:armhf libncursesw6:armhf libcups2:armhf
    apt-get install -y --no-install-recommends g++-arm-linux-gnueabihf libc6-dev-armhf-cross libssl-dev:armhf libwebkit2gtk-4.1-0:armhf libjavascriptcoregtk-4.1-0:armhf libsoup2.4-dev:armhf libgtk-3-dev:armhf patchelf:armhf librsvg2-dev:armhf libxdo-dev:armhf libxcb1:armhf libxrandr2:armhf libdbus-1-3:armhf libayatana-appindicator3-dev:armhf
    export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc
    export CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc
    export CXX_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-g++
    export PKG_CONFIG_PATH=/usr/lib/arm-linux-gnueabihf/pkgconfig
    export PKG_CONFIG_ALLOW_CROSS=1
else
    echo "Unknown target: $INPUT_TARGET" && exit 1
fi

# Tauri 1 uses the 4.0 pkg-config names. Resolve those names to the real
# 4.1 SONAMEs using a private build directory, with no runtime aliases.
case "$INPUT_TARGET" in
    x86_64-*) deb_arch=amd64 ;;
    i686-*) deb_arch=i386 ;;
    aarch64-*) deb_arch=arm64 ;;
    armv7-*) deb_arch=armhf ;;
esac
multiarch="$(dpkg-architecture -a "$deb_arch" -qDEB_HOST_MULTIARCH)"
compat_dir="$(mktemp -d)"
trap 'rm -rf "$compat_dir"' EXIT
for pair in webkit2gtk javascriptcoregtk; do
    soname="lib$pair-4.1.so.0"
    test -f "/usr/lib/$multiarch/$soname"
    ln -s "/usr/lib/$multiarch/$soname" "$compat_dir/lib$pair-4.1.so"
    package_version="$(dpkg-query -W -f='${Version}' "lib$pair-4.1-0:$deb_arch")"
    version="$(sed -E 's/^[0-9]+://; s/[^0-9.].*$//' <<< "$package_version")"
    cat > "$compat_dir/$pair-4.0.pc" <<EOF
Name: $pair (Tauri 1 build alias)
Description: Resolve the legacy binding against the WebKitGTK 4.1 ABI
Version: $version
Libs: -L$compat_dir -l$pair-4.1
EOF
done
export PKG_CONFIG_PATH="$compat_dir${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
# Also cover dependencies with a hardcoded #[link] name.
for pair in webkit2gtk javascriptcoregtk; do
    ln -s "$compat_dir/lib$pair-4.1.so" "$compat_dir/lib$pair-4.0.so"
done
# The Wry backport uses libsoup 3 for the header object returned by 4.1.
ln -s "/usr/lib/$multiarch/libsoup-3.0.so.0" "$compat_dir/libsoup-3.0.so"
export LIBRARY_PATH="$compat_dir${LIBRARY_PATH:+:$LIBRARY_PATH}"
bash .github/actions/build.sh
