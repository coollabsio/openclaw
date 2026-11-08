ARG BASE_IMAGE=ghcr.io/coollabsio/openclaw-base:latest

FROM ${BASE_IMAGE}

ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    nginx \
    apache2-utils \
  && rm -rf /var/lib/apt/lists/*

# Remove default nginx site
RUN rm -f /etc/nginx/sites-enabled/default

# Docker client only. Agent sandboxing shells out to `docker` and creates
# sibling containers on the host engine through a mounted socket. The static
# tarball also contains the engine; extract the client and leave the engine
# on the host. scripts/docker-cli.js is the PATH entry so a named volume on
# /data can be reported as a host bind. See README "Agent sandbox".
ARG DOCKER_CLI_VERSION=29.9.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) docker_arch="x86_64" ;; \
      arm64) docker_arch="aarch64" ;; \
      *) echo "unsupported architecture for docker CLI: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /tmp docker/docker; \
    install -d /usr/local/libexec; \
    install -m 0755 /tmp/docker/docker /usr/local/libexec/openclaw-docker; \
    rm -rf /tmp/docker

# OpenClaw's GitHub device sign-in and agent commands need gh on the gateway PATH.
RUN set -eux; \
    version="2.103.3"; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) checksum="4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d" ;; \
      arm64) checksum="ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63" ;; \
      *) echo "unsupported architecture for GitHub CLI: ${arch}" >&2; exit 1 ;; \
    esac; \
    archive="gh_${version}_linux_${arch}"; \
    tmp="$(mktemp -d)"; \
    cd "$tmp"; \
    curl -fsSL --retry 3 -o "${archive}.tar.gz" "https://github.com/cli/cli/releases/download/v${version}/${archive}.tar.gz"; \
    printf '%s  %s\n' "$checksum" "${archive}.tar.gz" | sha256sum -c -; \
    tar -xzf "${archive}.tar.gz" "${archive}/bin/gh"; \
    install -m 0755 "${archive}/bin/gh" /usr/local/bin/gh; \
    cd /; \
    rm -rf "$tmp"

COPY scripts/ /app/scripts/
# Re-install the CLI wrapper from this repo so an older base image still refuses
# `openclaw update`. Wrap npm so `npm i -g openclaw` stops before EEXIST.
# `docker` on PATH is the sandbox client wrapper, not the engine.
RUN chmod +x /app/scripts/*.sh /app/scripts/docker-cli.js \
  && ln -sf /app/scripts/docker-cli.js /usr/local/bin/docker \
  && mkdir -p /usr/local/lib/openclaw \
  && cp /app/scripts/image-update-guard.sh /usr/local/lib/openclaw/image-update-guard.sh \
  && cp /app/scripts/openclaw-bin.sh /usr/local/bin/openclaw \
  && rm -f /usr/local/bin/npm \
  && cp /app/scripts/npm-guard.sh /usr/local/bin/npm \
  && chmod 755 /usr/local/bin/openclaw /usr/local/bin/npm /usr/local/lib/openclaw/image-update-guard.sh \
  && test ! -L /usr/local/bin/npm \
  && test -f /usr/local/lib/node_modules/npm/bin/npm-cli.js \
  && head -1 /usr/local/lib/node_modules/npm/bin/npm-cli.js | grep -q node

# /data/venv is created at startup and must stay ahead of Debian's python3/pip.
# uv tool installs (Control UI skill installer) write executables to UV_TOOL_BIN_DIR,
# not UV_TOOL_DIR. The default bin dir is ~/.local/bin, which is not on PATH.
# Keep the bin dir beside the tool dir: uv treats every child of UV_TOOL_DIR as a tool.
ENV NPM_CONFIG_PREFIX="/data/npm-global" \
    UV_TOOL_DIR="/data/uv/tools" \
    UV_TOOL_BIN_DIR="/data/uv/bin" \
    UV_CACHE_DIR="/data/uv/cache" \
    UV_PYTHON_INSTALL_DIR="/data/uv/python" \
    VIRTUAL_ENV="/data/venv" \
    GOPATH="/data/go" \
    PATH="/data/venv/bin:/data/npm-global/bin:/data/uv/bin:/data/go/bin:${PATH}"

# The node image sets HOME=/root. OpenClaw stores chat history under
# ~/.openclaw unless these are set for every process, including `docker exec`
# and Coolify terminals, which do not inherit entrypoint exports. /root is not
# on the /data volume, so those sessions disappear when the container is recreated.
ENV HOME=/data \
    OPENCLAW_HOME=/data \
    OPENCLAW_STATE_DIR=/data/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/data/workspace

ENV PORT=8080
EXPOSE 8080

# /healthz is the gateway live probe and returns 503 until that port accepts
# connections. First boot copies Linuxbrew onto the volume, then runs
# configure.js, doctor --fix, and the gateway. The startup page allows a few
# minutes for that. Failures during start-period do not count, and the first
# success marks the container healthy immediately, so a slow boot is not
# unhealthy and a later gateway death still trips --retries.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8080}/healthz || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
