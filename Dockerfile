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
# Re-install the CLI wrapper from this repo so an older base image still refuses
# `openclaw update`. Wrap npm so `npm i -g openclaw` stops before EEXIST.
RUN chmod +x /app/scripts/*.sh \
  && mkdir -p /usr/local/lib/openclaw \
  && cp /app/scripts/image-update-guard.sh /usr/local/lib/openclaw/image-update-guard.sh \
  && cp /app/scripts/openclaw-bin.sh /usr/local/bin/openclaw \
  && rm -f /usr/local/bin/npm \
  && cp /app/scripts/npm-guard.sh /usr/local/bin/npm \
  && chmod 755 /usr/local/bin/openclaw /usr/local/bin/npm /usr/local/lib/openclaw/image-update-guard.sh \
  && test ! -L /usr/local/bin/npm \
  && test -f /usr/local/lib/node_modules/npm/bin/npm-cli.js \
  && head -1 /usr/local/lib/node_modules/npm/bin/npm-cli.js | grep -q node

ENV NPM_CONFIG_PREFIX="/data/npm-global" \
    UV_TOOL_DIR="/data/uv/tools" \
    UV_CACHE_DIR="/data/uv/cache" \
    GOPATH="/data/go" \
    PATH="/data/npm-global/bin:/data/uv/tools/bin:/data/go/bin:${PATH}"

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
