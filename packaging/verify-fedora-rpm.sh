#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Usage: $0 path/to/cup-translate.rpm (run on a matching Linux Docker architecture)" >&2
    exit 2
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
context="$(mktemp -d)"
image_file="$context/image-id"
trap 'if [ -s "$image_file" ]; then docker image rm "$(cat "$image_file")" >/dev/null 2>&1 || true; fi; rm -rf "$context"' EXIT
cp "$1" "$context/candidate.rpm"
cp "$script_dir/fedora-smoke/"{Dockerfile,launch.sh} "$context/"
docker build --iidfile "$image_file" "$context"
docker run --rm --network none "$(cat "$image_file")"
