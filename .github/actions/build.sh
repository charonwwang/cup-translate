set -euo pipefail
pnpm install --frozen-lockfile
pnpm test
sed -i "s/#openssl/openssl={version=\"0.10\",features=[\"vendored\"]}/g" src-tauri/Cargo.toml
if [ "${BUILD_VERIFY_ONLY:-false}" = true ]; then
    # Exercise real installer bundling without signing or publishing a release.
    pnpm tauri build --target "$INPUT_TARGET" -b deb,rpm --config .github/tauri.verify.conf.json
elif [ "$INPUT_TARGET" = "x86_64-unknown-linux-gnu" ]; then
    export APPIMAGE_BUNDLE_GSTREAMER=1
    pnpm tauri build --target $INPUT_TARGET
else
    pnpm tauri build --target $INPUT_TARGET -b deb rpm
fi
node scripts/fix-deb-dependencies.mjs "src-tauri/target/$INPUT_TARGET/release/bundle/deb"
