#!/usr/bin/env bash
# /usr/local/bin/npm — passes through to the Node image's npm CLI.
# A global install or update of the openclaw package refuses first, so npm
# never tries to replace /usr/local/bin/openclaw (EEXIST) or shadow it from /data.
set -euo pipefail

guard="/usr/local/lib/openclaw/image-update-guard.sh"
if [ ! -f "$guard" ]; then
  guard="$(cd "$(dirname "$0")" && pwd)/image-update-guard.sh"
fi
# shellcheck source=image-update-guard.sh
. "$guard"

if image_update_npm_is_openclaw_global "$@"; then
  image_update_refuse
fi

exec node /usr/local/lib/node_modules/npm/bin/npm-cli.js "$@"
