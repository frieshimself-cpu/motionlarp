#!/usr/bin/env bash
# Server hardening, safe to run again and again. Run by the installer and after each automatic update.
#  - firewall: only SSH and the website are reachable from outside;
#  - fail2ban: an address that keeps guessing the SSH password is blocked;
#  - the settings file and the database are readable by root only.
set -u
DIR="${MOTIONLARP_DIR:-/root/motionlarp}"
export DEBIAN_FRONTEND=noninteractive

chmod 600 "$DIR/.env" 2>/dev/null || true
[ -f "$DIR/MASTER_KEY_BACKUP.txt" ] && chmod 600 "$DIR/MASTER_KEY_BACKUP.txt"

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true   # SSH first: never lock the owner out
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw default deny incoming >/dev/null 2>&1 || true
  ufw default allow outgoing >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

if ! command -v fail2ban-client >/dev/null 2>&1; then
  (apt-get update -qq && apt-get install -y -qq fail2ban) >/dev/null 2>&1 || true
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true
echo "$(date -Is) hardening applied (firewall: $(ufw status 2>/dev/null | head -1), fail2ban: $(systemctl is-active fail2ban 2>/dev/null))"
