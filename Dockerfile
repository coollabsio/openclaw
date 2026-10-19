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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-8080}/healthz || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
