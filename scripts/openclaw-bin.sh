#!/usr/bin/env bash
# /usr/local/bin/openclaw — wrapper around the source build in this image.
# `openclaw update` and `openclaw --update` refuse with the image-tag update path.
set -euo pipefail

guard="/usr/local/lib/openclaw/image-update-guard.sh"
if [ ! -f "$guard" ]; then
  guard="$(cd "$(dirname "$0")" && pwd)/image-update-guard.sh"
fi
# shellcheck source=image-update-guard.sh
. "$guard"

if image_update_openclaw_is_update "$@"; then
  image_update_refuse
fi

exec node /opt/openclaw/app/openclaw.mjs "$@"
