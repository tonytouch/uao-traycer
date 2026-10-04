#!/usr/bin/env bash
# Installs the uao-serve user unit and config. Does NOT start, enable or expose
# anything, and does not touch `tailscale serve`. Safe to re-run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop="$(cd "$here/../.." && pwd)"
conf="$HOME/.config/uao-serve"
unit_dir="$HOME/.config/systemd/user"

for f in dist/serve-uao/index.js dist/renderer-uao/uao.html; do
  if [ ! -f "$desktop/$f" ]; then
    echo "missing $desktop/$f - build first:" >&2
    echo "  (cd $desktop && bun run build:uao:renderer && bun run build:uao:serve)" >&2
    exit 1
  fi
done

mkdir -p "$conf" "$unit_dir"
chmod 700 "$conf"

if [ ! -f "$conf/pairing-secret" ]; then
  (umask 077 && node "$desktop/dist/serve-uao/index.js" --generate-secret > "$conf/pairing-secret")
  echo "created $conf/pairing-secret (mode 600; not printed)"
else
  chmod 600 "$conf/pairing-secret"
  echo "kept existing $conf/pairing-secret"
fi

if [ ! -f "$conf/uao-serve.env" ]; then
  cp "$here/uao-serve.env.example" "$conf/uao-serve.env"
  chmod 600 "$conf/uao-serve.env"
  echo "created $conf/uao-serve.env - check UAO_SERVE_ALLOWED_ORIGINS"
else
  echo "kept existing $conf/uao-serve.env"
fi

cp "$here/uao-serve.service" "$unit_dir/uao-serve.service"
systemctl --user daemon-reload
echo "installed $unit_dir/uao-serve.service (not started)"
echo "next steps: see $here/README.md"
