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

COPY scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

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
