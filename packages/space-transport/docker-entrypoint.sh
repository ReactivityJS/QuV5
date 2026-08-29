#!/bin/sh
# A Docker named/bind-mounted volume is root-owned by default, and Docker
# only ever fixes a volume's ownership FROM the image on that volume's
# first creation - never on later starts. Runs as root at container
# start, fixes SPACE_RELAY_DATA_DIR's ownership, then drops to the
# unprivileged `quniverse` user before actually running the relay.
set -e

if [ "$(id -u)" = '0' ]; then
  if [ -n "$SPACE_RELAY_DATA_DIR" ]; then
    mkdir -p "$SPACE_RELAY_DATA_DIR"
    chown -R quniverse:quniverse "$SPACE_RELAY_DATA_DIR"
  fi
  exec su-exec quniverse "$@"
fi

# Already non-root (e.g. someone set `user:` themselves in compose) - run as-is.
exec "$@"
