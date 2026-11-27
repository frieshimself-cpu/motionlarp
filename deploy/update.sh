#!/usr/bin/env bash
# Run by cron every 2 minutes: if the branch on GitHub has new commits, pull them, rebuild and restart, then check that
# the app answers. A version whose build fails or whose app does not answer after the restart is rolled back to the
# one that ran before (never left crash-looping with open positions unattended), and is tried again only after half an
# hour (a network or disk hiccup) or as soon as a newer commit arrives. The app shuts down gracefully (in-flight trades
# finish; open positions and their sell rules survive a restart).
set -euo pipefail
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
cd "$DIR"
exec 9> "${MOTIONLARP_LOCK:-/tmp/motionlarp-update.lock}"
flock -n 9 || exit 0
COMPOSE="${MOTIONLARP_COMPOSE:-docker compose}"
# Does the app answer? Asked from inside its own container (its port is not published).
HEALTH="${MOTIONLARP_HEALTH:-docker compose exec -T app node -e \"fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))\"}"
TRIES="${MOTIONLARP_HEALTH_TRIES:-45}"
PAUSE="${MOTIONLARP_HEALTH_PAUSE:-2}"
PRUNE="${MOTIONLARP_PRUNE:-docker image prune -f}"
RETRY_AFTER_SEC=1800

git fetch --quiet origin
REMOTE=$(git rev-parse '@{u}')
# What runs now: written after every deploy whose app answered; before the first one, the checkout.
DEPLOYED=$(cat .deployed 2>/dev/null || git rev-parse HEAD)
if [ "$DEPLOYED" = "$REMOTE" ]; then
  # Nothing new. Until the Helius link and the Jupiter key are in .env, keep trying to move them there (a no-op after).
  if [ -x deploy/keys-to-env.sh ]; then deploy/keys-to-env.sh || true; fi
  exit 0
fi
if [ -f .failed ]; then
  read -r FAILED_COMMIT FAILED_AT < .failed || true
  if [ "${FAILED_COMMIT:-}" = "$REMOTE" ] && [ $(( $(date +%s) - ${FAILED_AT:-0} )) -lt $RETRY_AFTER_SEC ]; then exit 0; fi
fi

healthy() {
  for _ in $(seq 1 "$TRIES"); do
    if bash -c "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep "$PAUSE"
  done
  return 1
}
# Builds and starts what is checked out (the image is told its commit, shown on the Status tab), then waits for it.
deploy() {
  env COMMIT="$(git rev-parse --short HEAD)" $COMPOSE up -d --build && healthy
}

PREV=$(git rev-parse HEAD)
echo "$(date -Is) updating $DEPLOYED -> $REMOTE"
if git pull --ff-only --quiet && deploy; then
  git rev-parse HEAD > .deployed
  rm -f .failed
  echo "$(date -Is) updated to $(git rev-parse --short HEAD)"
  $PRUNE > /dev/null 2>&1 || true
else
  echo "$REMOTE $(date +%s)" > .failed
  git reset --hard --quiet "$PREV"
  if deploy; then
    echo "$PREV" > .deployed
    echo "$(date -Is) UPDATE FAILED for $(git rev-parse --short "$REMOTE"): rolled back to $(git rev-parse --short "$PREV"), which answers"
  else
    echo "$(date -Is) UPDATE FAILED for $(git rev-parse --short "$REMOTE"), rolled back to $(git rev-parse --short "$PREV"), which does not answer either"
  fi
fi
# Server hardening that ships with the code (idempotent; never fails the update).
if [ -x deploy/harden.sh ]; then deploy/harden.sh || true; fi
