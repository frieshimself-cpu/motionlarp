#!/usr/bin/env bash
# The Helius link (RPC_URL) and the Jupiter key (JUPITER_API_KEY) live in this server's .env file: set once, used
# for every user, not visible or changeable on the website. A server whose owner typed them into the admin page in
# the past still has them in its database: this moves them into .env, once, by itself (the updater runs it).
# Safe to run again and again: a value already in .env is never touched, and nothing is ever printed but names.
set -u
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
ENV_FILE="$DIR/.env"
[ -f "$ENV_FILE" ] || exit 0

has() { grep -Eq "^$1=.+" "$ENV_FILE"; }
if has RPC_URL && has JUPITER_API_KEY; then exit 0; fi

cd "$DIR" || exit 0
# What was saved on the admin page, as NAME=value lines (nothing when nothing was saved, or the app is not up).
EXPORT_CMD="${MOTIONLARP_EXPORT:-docker compose exec -T app node --disable-warning=ExperimentalWarning dist/export-connections.js}"
SAVED=$($EXPORT_CMD 2>/dev/null) || exit 0
[ -n "$SAVED" ] || exit 0

NEW=$(cat "$ENV_FILE")
MOVED=""
for NAME in RPC_URL JUPITER_API_KEY; do
  if has "$NAME"; then continue; fi
  # One whole line "NAME=value" with a plain value: no spaces, quotes, $ or #.
  LINE=$(printf '%s\n' "$SAVED" | grep -m1 -E "^$NAME=[A-Za-z0-9:/?&=._~%+@,-]+$") || continue
  NEW=$(printf '%s\n' "$NEW" | grep -v "^$NAME=" || true)
  NEW=$(printf '%s\n%s' "$NEW" "$LINE")
  MOVED="$MOVED $NAME"
done
[ -n "$MOVED" ] || exit 0

umask 077
cp -p "$ENV_FILE" "$ENV_FILE.before-keys" || exit 0
chmod 600 "$ENV_FILE.before-keys"
printf '%s\n' "$NEW" > "$ENV_FILE.new" || exit 0
chmod 600 "$ENV_FILE.new"
mv -f "$ENV_FILE.new" "$ENV_FILE" || exit 0
echo "$(date -Is) now set in .env (permanent, not on the website):$MOVED"

# The app reads .env when it starts: start it again with the file as it is now.
RESTART_CMD="${MOTIONLARP_RESTART:-docker compose up -d}"
$RESTART_CMD >/dev/null 2>&1 || true
