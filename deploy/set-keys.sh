#!/usr/bin/env bash
# Set or replace the Helius link and the Jupiter key on this server:
#   bash /root/motionlarp/deploy/set-keys.sh
# They are written into the server's .env file (RPC_URL and JUPITER_API_KEY), each tested with a real request first,
# and stay there for good: used for every user, not visible or changeable on the website. What you type is not shown
# on screen. Press Enter at a question to keep what is already set.
set -u
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
ENV_FILE="$DIR/.env"
PLAIN='^[A-Za-z0-9:/?&=._~%+@,-]+$'
[ -f "$ENV_FILE" ] || { echo "The site is not installed here ($ENV_FILE is missing). Run the installer first."; exit 1; }

has() { grep -Eq "^$1=.+" "$ENV_FILE"; }
put() { # put NAME VALUE: replaces the line, keeps every other line
  local rest
  rest=$(grep -v "^$1=" "$ENV_FILE" || true)
  ( umask 077; printf '%s\n%s=%s\n' "$rest" "$1" "$2" > "$ENV_FILE.new" ) || return 1
  chmod 600 "$ENV_FILE.new" && mv -f "$ENV_FILE.new" "$ENV_FILE"
}
ask_hidden() { # ask_hidden VAR "question": a value given in the environment is used as is (for scripts)
  local __var="$1" __ans=""
  if [ -n "${!__var:-}" ]; then return 0; fi
  printf '%s: ' "$2"
  { IFS= read -rs __ans < /dev/tty; } 2>/dev/null || __ans=""
  echo
  printf -v "$__var" '%s' "$__ans"
}
rpc_works() {
  [ -n "${MOTIONLARP_SKIP_CHECK:-}" ] && return 0
  curl -s -m 10 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' "$1" 2>/dev/null | grep -q '"result"'
}
jupiter_works() {
  [ -n "${MOTIONLARP_SKIP_CHECK:-}" ] && return 0
  curl -s -m 10 -H "x-api-key: $1" 'https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&slippageBps=50' 2>/dev/null | grep -q '"outAmount"'
}

CHANGED=""
HELIUS_RPC_URL="${HELIUS_RPC_URL:-}"
ask_hidden HELIUS_RPC_URL "1/2  Helius RPC link (Helius → RPC → \"RPC URL\")$(has RPC_URL && echo ' — Enter keeps the current one')"
if [ -n "$HELIUS_RPC_URL" ]; then
  if [[ ! "$HELIUS_RPC_URL" =~ ^https:// ]] || [[ ! "$HELIUS_RPC_URL" =~ $PLAIN ]]; then
    echo "    That is not a link: it must be the whole RPC URL, starting with https://. Nothing changed."; exit 1
  fi
  if ! rpc_works "$HELIUS_RPC_URL"; then echo "    That link did not answer. Copy the whole RPC URL from Helius and try again. Nothing changed."; exit 1; fi
  put RPC_URL "$HELIUS_RPC_URL" || { echo "    Could not write $ENV_FILE"; exit 1; }
  echo "    Helius link: tested and saved."
  CHANGED=1
fi

JUPITER_KEY="${JUPITER_KEY:-}"
ask_hidden JUPITER_KEY "2/2  Jupiter API key (portal.jup.ag)$(has JUPITER_API_KEY && echo ' — Enter keeps the current one')"
if [ -n "$JUPITER_KEY" ]; then
  if [[ ! "$JUPITER_KEY" =~ $PLAIN ]]; then echo "    That does not look like a key. Nothing changed for Jupiter."; exit 1; fi
  if ! jupiter_works "$JUPITER_KEY"; then echo "    Jupiter did not accept that key. Copy the whole key from portal.jup.ag and try again."; exit 1; fi
  put JUPITER_API_KEY "$JUPITER_KEY" || { echo "    Could not write $ENV_FILE"; exit 1; }
  echo "    Jupiter key: tested and saved."
  CHANGED=1
fi

if [ -z "$CHANGED" ]; then echo "Nothing changed."; exit 0; fi
echo "Restarting the site with the new settings (open trades finish first)…"
cd "$DIR" || exit 1
RESTART_CMD="${MOTIONLARP_RESTART:-docker compose up -d}"
$RESTART_CMD >/dev/null 2>&1 || { echo "    Could not restart: run  docker compose up -d  in $DIR"; exit 1; }
echo "Done. They are set on this server for good."
