# syntax=docker/dockerfile:1
#
# Builds and runs the Qu V5 space-relay (relay-server.js) - a WebSocket
# relay for @qu/space-core peers that mirrors every envelope it forwards
# to disk (see relay-server.js's own doc comment) and never decrypts
# anything. No client apps/UI are built or served here - see
# docs/v5-space-core-guide.md for what this relay does and doesn't do.
#
# Build from the REPO ROOT (npm workspaces need the whole tree to resolve
# @qu/core/@qu/space-* via their workspace symlinks):
#   docker build -f packages/space-transport/Dockerfile -t qu-space-relay .

FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache su-exec \
  && addgroup -S quniverse && adduser -S quniverse -G quniverse

COPY --from=builder --chown=quniverse:quniverse /app .
COPY --chmod=755 packages/space-transport/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 8081
ENV QU_RELAY_PORT=8081
ENV QU_RELAY_DATA_DIR=/data

# A container stuck "Up" but not actually answering is exactly what makes
# a reverse proxy in front of it start returning 502/503 - report
# unhealthy instead of just "the process hasn't exited."
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.QU_RELAY_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# QU_MEMBERS_JSON has NO default and the container starts fine without it -
# it only gates 'members'-mode ACL Kinds (a genuine access-control decision
# only an operator can make); 'owner'/'named'-ACL Kinds are self-certifying
# and need no membership configuration at all. See relay-server.js's own
# doc comment for the full "why" and for QU_FEDERATE_UPSTREAM_URL.
#
# This relay's OWN identity (only needed for federation) is auto-generated
# on first boot and persisted under QU_RELAY_DATA_DIR - never something you
# need to generate and pass in before the container can start. To read it
# without starting the WebSocket server (e.g. to register this relay as a
# federation peer/member elsewhere):
#   docker run --rm -v qu-space-relay-data:/data qu-space-relay \
#     node packages/space-transport/src/relay-server.js --print-identity
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/space-transport/src/relay-server.js"]
