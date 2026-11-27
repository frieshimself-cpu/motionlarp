#!/usr/bin/env bash
# One-command install for a fresh Ubuntu server:
#   bash <(curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/motionlarp/claude/ecstatic-mccarthy-q58vzz/deploy/install.sh)
# Installs Docker, downloads the site, asks for the domain, an admin password, the Helius link and the Jupiter key,
# starts everything, and switches on automatic updates. Fees, limits and license keys are set on the admin page.
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
  # No terminal to ask on (run from a script): stop with a clear message rather than loop.
  if ! IFS= read -r __ans < /dev/tty 2>/dev/null; then echo; echo "This installer needs a terminal to ask its questions. Run it by hand in the server's shell."; exit 1; fi
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

ask_admin_password() {
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  while [[ ! "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9._!@-]{10,}$ ]]; do
    [ -n "$ADMIN_PASSWORD" ] && echo "    At least 10 characters: letters, numbers and . _ - ! @"
    ADMIN_PASSWORD=""
    ask ADMIN_PASSWORD "Choose an ADMIN PASSWORD for the owner page (10+ characters; do not reuse another password)"
  done
}

if [ ! -f .env ]; then
  say "Two questions (press Enter to accept the value in [brackets])"
  ask DOMAIN "1/2  Your domain" "walletmotion.app"
  ask_admin_password
  MASTER_KEY=$(openssl rand -hex 32)
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
ADMIN_PASSWORD=$ADMIN_PASSWORD
MASTER_KEY=$MASTER_KEY
PORT=3000
DB_PATH=./data/motionlarp.db
LOG_LEVEL=info
# The Helius link (RPC_URL) and the Jupiter key (JUPITER_API_KEY) are added below by deploy/set-keys.sh.
# Fee, max per buy, live trading and license keys are set on the admin page: https://$DOMAIN/admin
ENV
  # A copy of the master key the owner can move somewhere safe: without it, stored wallet keys are unreadable.
  printf '%s\n' "$MASTER_KEY" > "$DIR/MASTER_KEY_BACKUP.txt"
  say "Settings saved"
elif ! grep -q '^ADMIN_PASSWORD=..........' .env; then
  say "One question: the new owner page needs a password"
  ask_admin_password
  sed -i '/^ADMIN_PASSWORD=/d' .env
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD" >> .env
  say "Admin password saved (your other settings are kept)"
else
  say "Keeping your existing settings (.env)"
fi

# The Helius link and the Jupiter key live in this server's .env file: asked here once, never on the website.
if [ -z "$DRY" ] && ! grep -Eq '^RPC_URL=.+' .env; then
  say "Two more: your Helius link and your Jupiter key (what you type is not shown; Enter skips one for now)"
  chmod +x "$DIR/deploy/set-keys.sh" 2>/dev/null || true
  MOTIONLARP_DIR="$DIR" MOTIONLARP_RESTART=true bash "$DIR/deploy/set-keys.sh" || echo "    Not saved. Set them later with:  bash $DIR/deploy/set-keys.sh"
fi

# Updates install themselves: every 2 minutes the server checks for new code and, if there is any, rebuilds and
# restarts (in-flight trades finish first). Remove /etc/cron.d/motionlarp-update to switch this off.
if [ -z "$DRY" ]; then
  chmod +x "$DIR/deploy/update.sh" 2>/dev/null || true
  printf 'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n*/2 * * * * root MOTIONLARP_DIR=%s %s/deploy/update.sh >> /var/log/motionlarp-update.log 2>&1\n' "$DIR" "$DIR" > /etc/cron.d/motionlarp-update
  chmod 644 /etc/cron.d/motionlarp-update
  say "Automatic updates are on"
  chmod +x "$DIR/deploy/harden.sh" 2>/dev/null && "$DIR/deploy/harden.sh" || true
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
    say "Done."
    echo "    Your site:        https://$DOMAIN_NOW   (give it a minute for the padlock certificate)"
    echo "    Your owner page:  https://$DOMAIN_NOW/admin   (log in with the admin password you chose)"
    echo "    There: set your fee and create license keys for you and your friends."
    echo "    To change the Helius link or the Jupiter key later:  bash $DIR/deploy/set-keys.sh"
    [ -f MASTER_KEY_BACKUP.txt ] && echo "    Your master key is in $DIR/MASTER_KEY_BACKUP.txt — copy it somewhere safe, then delete that file."
  else
    say "Something stopped it. The last lines of the log:"
    docker compose logs --tail 25 app || true
    echo
    echo "    Fix the setting it names with:  nano $DIR/.env   then run this installer again."
  fi
fi
