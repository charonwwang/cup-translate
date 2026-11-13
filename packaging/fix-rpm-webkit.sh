#!/usr/bin/env bash
set -euo pipefail
# Tauri 1 CLI appends a hardcoded RPM requirement for the 4.0 SONAME.
# Rebuild its payload only after the enclosing build has verified the real ABI.
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Usage: $0 path/to/cup-translate.rpm" >&2
    exit 2
fi
if [ -n "${RPM_SIGN_KEY:-}" ]; then
    echo 'Sign the final RPM after normalizing its dependency metadata.' >&2
    exit 1
fi
package="$(realpath "$1")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/payload"
rpm -K "$package"
bsdtar -xf "$package" -C "$tmp/payload"
read -r name version release arch license < <(rpm -qp --qf '%{NAME} %{VERSION} %{RELEASE} %{ARCH} %{LICENSE}\n' "$package")
test "$name" = cup-translate
case "$arch" in
    x86_64|aarch64) suffix='()(64bit)' ;;
    i686|i586|i386) suffix='' ;;
    *) echo "Unsupported RPM architecture: $arch" >&2; exit 1 ;;
esac
# Independently verify the extracted payload before altering metadata.
dynamic="$(readelf -d "$tmp/payload/usr/bin/cup-translate")"
grep -Fq '[libwebkit2gtk-4.1.so.0]' <<< "$dynamic"
if grep -Eq 'lib(webkit2gtk|javascriptcoregtk)-4\.0\.so|libsoup-2\.4\.so' <<< "$dynamic"; then
    echo 'RPM payload is not safe to package with the 4.1 runtime' >&2
    exit 1
fi
(
    cd "$tmp/payload"
    find . \( -type f -o -type l \) -printf '"/%P"\n' | LC_ALL=C sort
    find ./usr/lib/cup-translate -type d -printf '%%dir "/%P"\n' 2>/dev/null |
        sed 's|"/|"/usr/lib/cup-translate/|' || true
) | sed 's|cup-translate/"$|cup-translate"|' > "$tmp/files"
{
    printf 'Name: %s\nVersion: %s\nRelease: %s\nLicense: %s\n' "$name" "$version" "$release" "$license"
    printf 'Summary: %s\n' "$(rpm -qp --qf '%{SUMMARY}' "$package")"
    printf 'Requires: libwebkit2gtk-4.1.so.0%s\n' "$suffix"
    rpm -qp --requires "$package" |
        awk '!/^rpmlib\(/ && !/^libwebkit2gtk-4[.]0[.]so/ { print "Requires: " $0 }'
    printf '\n%%description\n%s\n' "$(rpm -qp --qf '%{DESCRIPTION}' "$package")"
    cat <<'SPEC'

%install
mkdir -p "%{buildroot}"
cp -a "%{_topdir}/payload/." "%{buildroot}/"

%files -f %{_topdir}/files
%defattr(-,root,root,-)
SPEC
} > "$tmp/cup.spec"
rpmbuild -bb --target "$arch" --define "_topdir $tmp" \
    --define '_build_id_links none' --define '_binary_filedigest_algorithm 8' \
    --define '__os_install_post %{nil}' "$tmp/cup.spec"
new="$tmp/RPMS/$arch/$name-$version-$release.$arch.rpm"
requires="$(rpm -qp --requires "$new")"
grep -Fq "libwebkit2gtk-4.1.so.0$suffix" <<< "$requires"
if grep -Fq 'libwebkit2gtk-4.0' <<< "$requires"; then
    echo 'Unexpected obsolete WebKitGTK dependency in rebuilt RPM' >&2
    exit 1
fi
# Repackaging must preserve every packaged file (including modes and digests).
rpm -qp --dump "$package" | awk '$5 !~ /^0?4/' | LC_ALL=C sort > "$tmp/before"
rpm -qp --dump "$new" | awk '$5 !~ /^0?4/' | LC_ALL=C sort > "$tmp/after"
# Build-time metadata may differ, but the file paths and actual payload bytes must not.
diff -u <(awk '{print $1,$2,$4,$5}' "$tmp/before") <(awk '{print $1,$2,$4,$5}' "$tmp/after")
cp "$new" "$package"
