#!/usr/bin/env bash
# Shared refusal for in-container OpenClaw upgrades.
# Sourced by scripts/openclaw-bin.sh and scripts/npm-guard.sh.

# Print the Coolify update path and exit 1.
image_update_refuse() {
  cat >&2 <<'EOF'
OpenClaw in this image is updated by pulling a newer image tag.

coollabsio/openclaw is rebuilt for each upstream release (version tags such as
2026.10.5, and :latest). On Coolify, pin coollabsio/openclaw:<version>, read the
release notes, change the tag, and redeploy. The /data volume keeps config,
credentials, workspace, and chat history. The new container runs
`openclaw doctor --fix` before the gateway listens.

`npm install -g openclaw` and `openclaw update` stop here. This binary wraps the
source build baked into the image, the gateway is PID 1, and a global install
under /data/npm-global would stay on the volume and hide later image tags.
EOF
  exit 1
}

# True when a token can be a root-option value (mirrors upstream isValueToken).
image_update_is_value_token() {
  local arg="${1:-}"
  if [ -z "$arg" ] || [ "$arg" = "--" ]; then
    return 1
  fi
  case "$arg" in
    -*)
      [[ "$arg" =~ ^-[0-9]+(\.[0-9]+)?$ ]]
      ;;
    *)
      return 0
      ;;
  esac
}

# True when argv is `openclaw update` or the root `--update` flag.
# Global flags that precede the command are skipped the same way the
# v2026.10.5 CLI scans them (`--profile`, `--log-level`, `--container`,
# `--dev`, `--no-color`). `--update` after another command is left alone.
image_update_openclaw_is_update() {
  local -a args=("$@")
  local i=0
  local arg
  local next

  while [ "$i" -lt "${#args[@]}" ]; do
    arg="${args[$i]}"
    if [ "$arg" = "--" ]; then
      next="${args[$((i + 1))]:-}"
      [ "$next" = "update" ]
      return
    fi
    if [ "$arg" = "--update" ]; then
      return 0
    fi
    case "$arg" in
      --dev|--no-color)
        i=$((i + 1))
        continue
        ;;
      --profile=*|--log-level=*|--container=*)
        i=$((i + 1))
        continue
        ;;
      --profile|--log-level|--container)
        next="${args[$((i + 1))]:-}"
        if image_update_is_value_token "$next"; then
          i=$((i + 2))
        else
          i=$((i + 1))
        fi
        continue
        ;;
      -*)
        i=$((i + 1))
        continue
        ;;
      update)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  done
  return 1
}

image_update_npm_command_writes_global() {
  case "${1:-}" in
    install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|update|up|upgrade)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

image_update_spec_is_openclaw() {
  case "${1:-}" in
    openclaw|openclaw@*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# True when npm would globally install or update the openclaw package.
image_update_npm_is_openclaw_global() {
  local -a args=("$@")
  local -a packages=()
  local i=0
  local arg
  local cmd=""
  local global=0

  while [ "$i" -lt "${#args[@]}" ]; do
    arg="${args[$i]}"
    if [ "$arg" = "--" ]; then
      i=$((i + 1))
      while [ "$i" -lt "${#args[@]}" ]; do
        if [ -z "$cmd" ]; then
          cmd="${args[$i]}"
        else
          packages+=("${args[$i]}")
        fi
        i=$((i + 1))
      done
      break
    fi
    case "$arg" in
      -g|--global)
        global=1
        i=$((i + 1))
        continue
        ;;
      --location=global)
        global=1
        i=$((i + 1))
        continue
        ;;
      --location)
        if [ "${args[$((i + 1))]:-}" = "global" ]; then
          global=1
        fi
        i=$((i + 2))
        continue
        ;;
      --prefix=*|--registry=*|--cache=*|--userconfig=*|--globalconfig=*|--tag=*|--omit=*|--workspace=*|--install-strategy=*|--os=*|--cpu=*|--libc=*|--script-shell=*|--loglevel=*|--logs-max=*|--depth=*)
        i=$((i + 1))
        continue
        ;;
      --prefix|--registry|--cache|--userconfig|--globalconfig|--tag|--omit|--workspace|-w|--install-strategy|--os|--cpu|--libc|--script-shell|--loglevel|--logs-max|--depth)
        i=$((i + 2))
        continue
        ;;
      -*)
        i=$((i + 1))
        continue
        ;;
      *)
        if [ -z "$cmd" ]; then
          cmd="$arg"
        else
          packages+=("$arg")
        fi
        i=$((i + 1))
        continue
        ;;
    esac
  done

  if [ "$global" -ne 1 ] || ! image_update_npm_command_writes_global "$cmd"; then
    return 1
  fi
  if [ "${#packages[@]}" -eq 0 ]; then
    return 1
  fi
  local spec
  for spec in "${packages[@]}"; do
    if image_update_spec_is_openclaw "$spec"; then
      return 0
    fi
  done
  return 1
}
