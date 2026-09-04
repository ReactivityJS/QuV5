# syntax=docker/dockerfile:1
#
# Builds and runs the Qu V5 App Shell relay (relay-server.js) - the
# generic-app counterpart to packages/space-transport/Dockerfile's own
# relay (which still serves demo/web/'s hardcoded chat demo, completely
# UNCHANGED by this image - see relay-server.js's own "WHY A SEPARATE
# ENTRYPOINT" doc comment for why this is a SEPARATE image/container, not a
# replacement). Run this ALONGSIDE that one, on a different port, to also
# serve @qu/app-shell from the same deployment.
#
# Build context MUST be the REPO ROOT, not this directory - same reason as
# packages/space-transport/Dockerfile's own (npm workspaces need the whole
# tree present) - see that file's own doc comment for the full "why" and
# for the two supported build invocations (local checkout, or directly from
# a GitHub ref). The same DO-NOT-use-`#ref:subdir`-context warning applies
# here identically.
#
#   docker build -f packages/app-shell/Dockerfile -t qu-app-shell-relay .
#
# @qu/app-shell's own JS bundle (relay-server.js's `buildAppShellBundle()`)
# is pubkey-agnostic, so - unlike its `index.html` (rendered at BOOT time
# from QU_APP_ADMIN_PUB, see relay-server.js's own doc comment) - it COULD
# be pre-bundled here at build time the same way packages/space-transport/
# Dockerfile pre-bundles demo/web/. It deliberately ISN'T: relay-server.js
# already does it once at boot (a few hundred ms, esbuild is already a
# regular - not dev-only - root dependency either way, see root
# package.json), which keeps this Dockerfile a plain, uniform copy of the
# OTHER one below instead of a third slightly-different variant. Revisit
# if that boot-time cost ever actually matters for a real deployment.

FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
# --omit=dev straight away, not "npm ci then npm prune --omit=dev" - nothing in this build (or the
# runtime image) ever needs a devDependency (jsdom, declared by five workspace packages purely for
# their own test files - see this repo's own architecture.md on the "in-process Space + jsdom" test
# pattern - is the heavy one), so installing its whole tree just to delete it again wastes real
# `npm ci` time for no benefit; a slow/rate-limited registry connection can turn that into minutes
# of apparently-stuck build output (only npm's own deprecation warnings print, no per-package
# progress) - a real, observed symptom this avoids entirely, not just a tidiness fix.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

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

# Same shape as packages/space-transport/Dockerfile's own healthcheck -
# relay-server.js serves the identical GET /healthz.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.QU_RELAY_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# QU_APP_ADMIN_PUB has NO default - the container starts fine without it (a
# plain setup page instead of an app, see relay-server.js's own doc
# comment) so an operator can stand the relay up FIRST and decide/generate
# the app-admin identity SEPARATELY, same posture packages/space-transport/
# Dockerfile already takes with QU_MEMBERS_JSON. See relay-server.js's own
# doc comment for every env var this image reads.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/app-shell/relay-server.js"]
