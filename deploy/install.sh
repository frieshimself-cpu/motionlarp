#!/usr/bin/env bash
# One-command install for a fresh Ubuntu server:
#   bash <(curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/motionlarp/claude/ecstatic-mccarthy-q58vzz/deploy/install.sh)
# Installs Docker, downloads the site, asks five questions, writes the settings, starts everything.
# Run it again any time to update: it keeps your settings and only pulls the new code and restarts.
set -euo pipefail

REPO="https://github.com/frieshimself-cpu/motionlarp"
BRANCH="claude/ecstatic-mccarthy-q58vzz"
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
DRY="${INSTALL_DRY_RUN:-}"

say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
ask() { # ask VAR "question" [default]
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -n "$__def" ]; then printf '%s [%s]: ' "$__q" "$__def"; else printf '%s: ' "$__q"; fi
  IFS= read -r __ans < /dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
run() { if [ -n "$DRY" ]; then echo "(dry run) $*"; else "$@"; fi; }

if [ -z "$DRY" ] && command -v cloud-init >/dev/null 2>&1; then
  say "Waiting for the server's first-boot setup to finish"
  cloud-init status --wait >/dev/null 2>&1 || true
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (a few minutes)"
  run sh -c "curl -fsSL https://get.docker.com | sh"
fi
if ! command -v git >/dev/null 2>&1; then run apt-get install -y git; fi

if [ -d "$DIR/.git" ]; then
  say "Updating the site's code"
  run git -C "$DIR" pull --ff-only
else
  say "Downloading the site"
  run git clone -b "$BRANCH" "$REPO" "$DIR"
fi
[ -n "$DRY" ] && mkdir -p "$DIR"
cd "$DIR"

if [ ! -f .env ]; then
  say "Five questions (press Enter to accept the value in [brackets])"
  ask RPC_URL "1/5  Your Helius RPC link (https://mainnet.helius-rpc.com/?api-key=...)"
  while [[ ! "$RPC_URL" =~ ^https?:// ]]; do echo "    That should start with https://"; RPC_URL=""; ask RPC_URL "1/5  Your Helius RPC link"; done
  ask DOMAIN "2/5  Your domain" "walletmotion.app"
  ask SIGNUP_CODE "3/5  Invite code your friends type to sign up"
  ask FEE_PERCENT "4/5  Your fee on every buy and sell, in % (0 = no fee)" "1"
  FEE_BPS=$(awk -v p="$FEE_PERCENT" 'BEGIN { printf "%d", p * 100 }')
  FEE_WALLET="${FEE_WALLET:-}"
  if [ "$FEE_BPS" -gt 0 ]; then
    ask FEE_WALLET "     Wallet address that receives the fee (must already hold 0.001 SOL or more)"
  fi
  ask FEE_EXEMPT_USERS "5/5  The username you will sign up with (pays no fee)"
  MASTER_KEY=$(openssl rand -hex 32)

  umask 077
  cat > .env <<ENV
RPC_URL=$RPC_URL
RPC_WS_URL=
MASTER_KEY=$MASTER_KEY
SIGNUP_CODE=$SIGNUP_CODE
LIVE_TRADING=false
MAX_SOL_PER_BUY=0.05
FEE_RESERVE_SOL=0.01
PORT=3000
DB_PATH=./data/motionlarp.db
LOG_LEVEL=info
DOMAIN=$DOMAIN
FEE_BPS=$FEE_BPS
FEE_WALLET=$FEE_WALLET
FEE_EXEMPT_USERS=$FEE_EXEMPT_USERS
JUPITER_URL=https://lite-api.jup.ag
JUPITER_API_KEY=
ENV
  # A copy of the master key the owner can move somewhere safe: without it, stored wallet keys are unreadable.
  printf '%s\n' "$MASTER_KEY" > "$DIR/MASTER_KEY_BACKUP.txt"
  say "Settings saved"
else
  say "Keeping your existing settings (.env)"
fi

say "Starting the site (the first time takes a few minutes)"
run docker compose up -d --build

if [ -z "$DRY" ]; then
  say "Checking it started"
  for _ in $(seq 1 30); do
    if docker compose logs app 2>/dev/null | grep -q 'motionlarp up'; then break; fi
    if docker compose ps app 2>/dev/null | grep -qiE 'exited|restarting'; then break; fi
    sleep 2
  done
  if docker compose logs app 2>/dev/null | grep -q 'motionlarp up'; then
    DOMAIN_NOW=$(grep '^DOMAIN=' .env | cut -d= -f2)
    say "Done. Open https://$DOMAIN_NOW (give it a minute for the padlock certificate)."
    [ -f MASTER_KEY_BACKUP.txt ] && echo "    Your master key is in $DIR/MASTER_KEY_BACKUP.txt — copy it somewhere safe, then delete that file."
  else
    say "Something stopped it. The last lines of the log:"
    docker compose logs --tail 25 app || true
    echo
    echo "    Fix the setting it names with:  nano $DIR/.env   then run this installer again."
  fi
fi
