#!/usr/bin/env bash
# Run by cron every 2 minutes: if the branch on GitHub has new commits, pull them, rebuild and restart.
# The app shuts down gracefully (in-flight trades finish; open positions and their sell rules survive a restart).
set -euo pipefail
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
cd "$DIR"
exec 9> /tmp/motionlarp-update.lock
flock -n 9 || exit 0
git fetch --quiet origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse '@{u}')
[ "$LOCAL" = "$REMOTE" ] && exit 0
echo "$(date -Is) updating $LOCAL -> $REMOTE"
git pull --ff-only --quiet
docker compose up -d --build
echo "$(date -Is) updated to $(git rev-parse --short HEAD)"
# Server hardening that ships with the code (idempotent; never fails the update).
if [ -x deploy/harden.sh ]; then deploy/harden.sh || true; fi
