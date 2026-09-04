# syntax=docker/dockerfile:1
#
# Builds and runs the Qu V5 space-relay (relay-server.js) - a WebSocket
# relay for @qu/space-core peers that mirrors every envelope it forwards
# to disk (see relay-server.js's own doc comment) and never decrypts
# anything. Also serves a browser app on the SAME port (today, demo/web/ -
# see relay-server.js's own "SERVES AN APP" doc comment for why that's a
# first step, not the final shape) - see docs/v5-space-core-guide.md for
# what this relay does and doesn't do.
#
# Build context MUST be the REPO ROOT, not this directory - npm workspaces
# (see the root package.json's "workspaces": ["packages/*"]) resolve
# @qu/core/@qu/space-* as LOCAL sibling packages, not from the npm
# registry (they aren't published there) - `npm ci` needs the whole tree
# present in the build context to do that at all, and every COPY/CMD path
# below is written relative to repo root on purpose.
#
# Locally, from the repo root:
#   docker build -f packages/space-transport/Dockerfile -t qu-space-relay .
#
# Directly from GitHub, no local clone needed - context is the WHOLE repo
# at that ref, `-f` just points at this Dockerfile within it:
#   docker build -f packages/space-transport/Dockerfile -t qu-space-relay \
#     https://github.com/ReactivityJS/QuV5.git#main
#
# DO NOT use Docker's git "#ref:subdir" context syntax with this
# directory, e.g. `...QuV5.git#main:packages/space-transport/` - that
# makes THIS DIRECTORY the entire build context, so every repo-root-
# relative path below (and npm's own workspace resolution) breaks: the
# sibling `@qu/core`/`@qu/space-core`/`@qu/space-storage` packages, and
# even this Dockerfile's own `COPY .../docker-entrypoint.sh` line, simply
# aren't there to find. This is an inherent property of building a
# workspace-dependent package's image out of a monorepo, not something
# fixable by adjusting paths in this file alone - the two commands above
# are the only supported way to build this image.

FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
# --omit=dev straight away, not "npm ci then npm prune --omit=dev" - esbuild (used by the build
# step right below) is a regular dependency, not dev-only, so this loses nothing; the devDependency
# tree (jsdom, declared by several workspace packages purely for their own test files) is never
# needed here or in the runtime image - installing it just to prune it again wastes real `npm ci`
# time, which a slow/rate-limited registry connection can turn into minutes of apparently-stuck
# build output (only npm's own deprecation warnings print meanwhile, no per-package progress) - a
# real, observed symptom this avoids entirely, not just a tidiness fix.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Bundles demo/web/main.js -> demo/web/dist/bundle.js at BUILD TIME (esbuild is a regular
# dependency, not dev-only, but doing this now means the runtime image never needs to run a
# bundler on every boot the way `npm run demo:relay` does - see relay-server.js's own doc comment).
RUN node demo/web/build.mjs

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
