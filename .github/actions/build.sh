set -euo pipefail
pnpm install --frozen-lockfile
pnpm test
sed -i "s/#openssl/openssl={version=\"0.10\",features=[\"vendored\"]}/g" src-tauri/Cargo.toml
if [ "${BUILD_VERIFY_ONLY:-false}" = true ]; then
    # Match the public installer formats without building signed update archives.
    bundles=deb,rpm
    if [ "$INPUT_TARGET" = x86_64-unknown-linux-gnu ]; then
        export APPIMAGE_BUNDLE_GSTREAMER=1
        bundles+=,appimage
    fi
    pnpm tauri build --target "$INPUT_TARGET" -b "$bundles"
elif [ "$INPUT_TARGET" = "x86_64-unknown-linux-gnu" ]; then
    export APPIMAGE_BUNDLE_GSTREAMER=1
    pnpm tauri build --target "$INPUT_TARGET"
else
    pnpm tauri build --target "$INPUT_TARGET" -b deb,rpm
fi
# A metadata rewrite cannot fix a binary still linked to the missing ABI.
dynamic="$(readelf -d "src-tauri/target/$INPUT_TARGET/release/cup-translate")"
if ! grep -Fq '[libwebkit2gtk-4.1.so.0]' <<< "$dynamic" ||
    grep -Eq 'lib(webkit2gtk|javascriptcoregtk)-4\.0\.so|libsoup-2\.4\.so' <<< "$dynamic"; then
    printf 'Unexpected WebKitGTK ABI in %s:\n%s\n' "$INPUT_TARGET" "$dynamic" >&2
    exit 1
fi
bundle="src-tauri/target/$INPUT_TARGET/release/bundle"
node scripts/fix-deb-dependencies.mjs "$bundle/deb"
for rpm in "$bundle"/rpm/*.rpm; do
    bash packaging/fix-rpm-webkit.sh "$rpm"
done

# Native hosts can execute the tests; never try to run a cross-built executable.
if [ "$(rustc -vV | sed -n 's/^host: //p')" = "$INPUT_TARGET" ]; then
    cargo test --manifest-path src-tauri/Cargo.toml --release --features custom-protocol --target "$INPUT_TARGET"
fi
