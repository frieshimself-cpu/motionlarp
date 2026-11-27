#!/usr/bin/env bash
# Run by cron every 2 minutes: if the branch on GitHub has new commits, pull them and build them while the running
# version keeps trading, then restart at a quiet moment and check that the app answers. Quiet: nothing open and
# nothing under way; after 20 minutes, a moment with nothing under way and nothing due in the next 30 s (a timed sell,
# a retry, a buy being settled) will do; after an hour, any moment (the app shuts down gracefully: an exit in progress
# finishes, trades in flight confirm, open positions and their sell rules survive a restart). The restart itself takes
# a few seconds. A version whose build fails is not started (the running one stays); one whose app does not answer
# after the restart is rolled back to the one that ran before (never left crash-looping with open positions
# unattended). Either is tried again only after half an hour (a network or disk hiccup) or as soon as a newer commit
# arrives.
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
# How busy the running app is (asked from inside its container, like the health check): idle, calm, due or trading.
# An app that does not say (a version before this, or one that does not answer) is restarted without waiting.
QUIET="${MOTIONLARP_QUIET:-docker compose exec -T app node -e \"fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/quiet').then((r)=>r.json()).then((j)=>console.log(j.state||'unknown'),()=>console.log('unknown'))\"}"
CALM_AFTER_SEC="${MOTIONLARP_CALM_AFTER_SEC:-1200}"
ANY_AFTER_SEC="${MOTIONLARP_ANY_AFTER_SEC:-3600}"
QUIET_PAUSE="${MOTIONLARP_QUIET_PAUSE:-2}"

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
# Builds what is checked out (the image is told its commit, shown on the Status tab); the running app is not touched.
build() {
  env COMMIT="$(git rev-parse --short HEAD)" $COMPOSE build
}
# Starts what was built (the running app is stopped gracefully and replaced), then waits for it to answer.
start() {
  env COMMIT="$(git rev-parse --short HEAD)" $COMPOSE up -d && healthy
}
# Waits for a moment when a restart cuts into nothing (see the top of this file).
wait_quiet() {
  local began state waited
  began=$(date +%s)
  while :; do
    state=$(bash -c "$QUIET" 2>/dev/null | tail -n 1 || true)
    waited=$(( $(date +%s) - began ))
    case "$state" in
      idle) return 0 ;;
      calm) [ "$waited" -ge "$CALM_AFTER_SEC" ] && return 0 ;;
      due|trading) ;;
      *) return 0 ;;
    esac
    if [ "$waited" -ge "$ANY_AFTER_SEC" ]; then
      echo "$(date -Is) still $state after $waited s: restarting all the same (the app finishes what is under way first)"
      return 0
    fi
    sleep "$QUIET_PAUSE"
  done
}

PREV=$(git rev-parse HEAD)
echo "$(date -Is) updating $DEPLOYED -> $REMOTE"
if ! git pull --ff-only --quiet; then
  echo "$(date -Is) UPDATE FAILED: could not pull $(git rev-parse --short "$REMOTE") (tried again in 2 minutes)"
  exit 0
fi
if ! build; then
  echo "$REMOTE $(date +%s)" > .failed
  git reset --hard --quiet "$PREV"
  echo "$(date -Is) UPDATE FAILED for $(git rev-parse --short "$REMOTE"): it does not build; $(git rev-parse --short "$DEPLOYED") keeps running"
elif wait_quiet && start; then
  git rev-parse HEAD > .deployed
  rm -f .failed
  echo "$(date -Is) updated to $(git rev-parse --short HEAD)"
  $PRUNE > /dev/null 2>&1 || true
else
  echo "$REMOTE $(date +%s)" > .failed
  git reset --hard --quiet "$PREV"
  if build && start; then
    echo "$PREV" > .deployed
    echo "$(date -Is) UPDATE FAILED for $(git rev-parse --short "$REMOTE"): rolled back to $(git rev-parse --short "$PREV"), which answers"
  else
    echo "$(date -Is) UPDATE FAILED for $(git rev-parse --short "$REMOTE"), rolled back to $(git rev-parse --short "$PREV"), which does not answer either"
  fi
fi
# Server hardening that ships with the code (idempotent; never fails the update).
if [ -x deploy/harden.sh ]; then deploy/harden.sh || true; fi
