#!/usr/bin/env bash
# Builds the UAO desktop for macOS (arm64) on this machine, ships it to a Mac
# over SSH, ad-hoc signs it there, writes the remote-backend config and
# relaunches it. Safe to re-run; only touches ~/Applications/UAO.app and the
# app's own data folder on the Mac.
#
#   MAC_HOST      ssh target of the Mac        (default tony@100.107.7.88)
#   UPSTREAM      https URL of this box's `tailscale serve` uao-serve gateway
#                 (default https://<this box's tailnet name>:10000/). The Mac app
#                 goes through it because the butler (Jarvis) only answers
#                 loopback callers, which the gateway is. The pairing secret
#                 (~/.config/uao-serve/pairing-secret) is copied to the Mac's app
#                 data folder, mode 600, and is never printed.
#                 UPSTREAM= (empty) dials BACKEND_HOST:BACKEND_PORT directly instead;
#                 everything but Jarvis' /ask and /speak works that way.
#   BACKEND_HOST  direct-mode backend host     (default: this box's tailscale IPv4)
#   BACKEND_PORT  direct-mode backend port     (default 5050)
#   SKIP_BUILD=1  reuse the existing release-uao/mac-arm64/UAO.app
#   NO_LAUNCH=1   install but do not start it
#   FORCE=1       build even when this box is under memory pressure
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/../.." && pwd)"
app="$desktop/release-uao/mac-arm64/UAO.app"

mac_host="${MAC_HOST:-tony@100.107.7.88}"
backend_port="${BACKEND_PORT:-5050}"
backend_host="${BACKEND_HOST:-$(tailscale ip -4 2>/dev/null | head -n1 || true)}"
if [ -z "$backend_host" ]; then
  echo "set BACKEND_HOST (could not read this box's tailscale IPv4)" >&2
  exit 1
fi
if [ -z "${UPSTREAM+x}" ]; then
  dns="$(tailscale status --json 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  UPSTREAM="${dns:+https://$dns:10000/}"
fi
secret_file="$HOME/.config/uao-serve/pairing-secret"
if [ -n "$UPSTREAM" ] && [ ! -s "$secret_file" ]; then
  echo "missing $secret_file - run deploy/uao-serve/install.sh first" >&2
  exit 1
fi
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  psi="$(awk '/^some/ {split($2,a,"="); print int(a[2])}' /proc/pressure/memory 2>/dev/null || echo 0)"
  if [ "${psi:-0}" -gt 20 ] && [ "${FORCE:-0}" != 1 ]; then
    echo "memory pressure avg10=${psi}% - wait for it to calm, or FORCE=1" >&2
    exit 1
  fi
  (cd "$desktop" && bun run build:uao &&
    bun x electron-builder --mac --arm64 --dir --config electron-builder.uao.json --publish never)
fi
[ -d "$app" ] || { echo "missing $app - build first" >&2; exit 1; }

# A tarball, not a zip: the zip target flattens the frameworks' symlinks and
# the app then fails to sign.
tgz="$(mktemp --suffix=.tgz)"
trap 'rm -f "$tgz"' EXIT
tar -C "$(dirname "$app")" -czf "$tgz" UAO.app
remote_tgz="/tmp/uao-mac-$$.tgz"
scp -q "${ssh_opts[@]}" "$tgz" "$mac_host:$remote_tgz"

if [ -n "$UPSTREAM" ]; then
  ssh "${ssh_opts[@]}" "$mac_host" 'd="$HOME/Library/Application Support/uao-desktop"; mkdir -p "$d" && umask 077 && cat > "$d/pairing-secret"' < "$secret_file"
fi

ssh "${ssh_opts[@]}" "$mac_host" bash -s -- "$backend_host" "$backend_port" "$remote_tgz" "${NO_LAUNCH:-0}" "$UPSTREAM" <<'REMOTE'
set -euo pipefail
backend_host="$1"; backend_port="$2"; tgz="$3"; no_launch="$4"; upstream="${5:-}"
mkdir -p "$HOME/Applications"
dest="$(cd "$HOME/Applications" && pwd -P)"

# Quit only this copy; an older UAO.app in /Applications must keep running.
pkill -f "$dest/UAO.app/Contents/" 2>/dev/null || true
sleep 1

rm -rf "$dest/UAO.app"
tar -xzf "$tgz" -C "$dest"
rm -f "$tgz"
xattr -cr "$dest/UAO.app"
codesign --force --deep -s - "$dest/UAO.app" >/dev/null 2>&1
codesign -v "$dest/UAO.app"

data="$HOME/Library/Application Support/uao-desktop"
mkdir -p "$data"
if [ -n "$upstream" ]; then
  printf '{"upstream":"%s"}\n' "$upstream" > "$data/backend.json"
  target="$upstream (via uao-serve)"
else
  printf '{"host":"%s","port":%s}\n' "$backend_host" "$backend_port" > "$data/backend.json"
  target="$backend_host:$backend_port (direct)"
fi
echo "installed $dest/UAO.app -> backend $target"

if [ "$no_launch" != 1 ]; then
  open "$dest/UAO.app"
  for _ in $(seq 1 60); do
    if curl -s -m3 -o /dev/null http://127.0.0.1:5183/desktop/uao.html; then
      code="$(curl -s -m10 -o /dev/null -w '%{http_code}' http://127.0.0.1:5183/uao-api/ || true)"
      echo "running; backend proxy answered HTTP $code"
      exit 0
    fi
    sleep 1
  done
  echo "launched but not answering on :5183 yet (the first start can take ~30 s)" >&2
  exit 1
fi
REMOTE
