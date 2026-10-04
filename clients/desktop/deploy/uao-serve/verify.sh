#!/usr/bin/env bash
# Checks a RUNNING uao-serve from this host: loopback and (if given) the
# tailnet HTTPS origin. Read-only GETs; never prints the pairing secret.
#
#   ./verify.sh                 loopback only
#   ./verify.sh --tailnet       also check the origin from uao-serve.env
set -uo pipefail

conf="$HOME/.config/uao-serve"
set -a
# shellcheck disable=SC1091
. "$conf/uao-serve.env"
set +a
secret="$(cat "$conf/pairing-secret")"
port="${UAO_SERVE_PORT:-5191}"
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok    $1 -> $3"; else echo "FAIL  $1 -> $3 (want $2)"; fail=1; fi
}
code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }

base="http://127.0.0.1:$port"
check "loopback unpaired UI"      401 "$(code "$base/desktop/uao.html")"
check "loopback unpaired API"     401 "$(code "$base/uao-api/api/hermes/kanban/boards")"
check "loopback wrong header"     401 "$(code -H 'x-uao-pairing: wrong' "$base/desktop/uao.html")"
check "loopback paired UI"        200 "$(code -H "x-uao-pairing: $secret" "$base/desktop/uao.html")"
check "loopback unknown Host"     403 "$(code -H 'Host: evil.example.com' -H "x-uao-pairing: $secret" "$base/desktop/uao.html")"

if [ "${1:-}" = "--tailnet" ]; then
  origin="${UAO_SERVE_ALLOWED_ORIGINS%%,*}"
  check "tailnet unpaired UI"     401 "$(code "$origin/desktop/uao.html")"
  check "tailnet paired UI"       200 "$(code -H "x-uao-pairing: $secret" "$origin/desktop/uao.html")"
  # A route outside /api/hermes/* only passes the backend's perimeter if no
  # forwarding or tailscale-* headers reach it (regression guard).
  check "tailnet paired backend API" 200 "$(code -H "x-uao-pairing: $secret" "$origin/uao-api/api/system/status")"
  # Cookie flags on the pairing redirect (the secret is in the URL, not printed).
  hdr="$(curl -s -m 10 -D - -o /dev/null "$origin/uao-pair?token=$secret" | tr -d '\r')"
  case "$hdr" in *"HttpOnly"*"Secure"*|*"Secure"*"HttpOnly"*) echo "ok    pairing cookie is HttpOnly + Secure" ;; *) echo "FAIL  pairing cookie flags"; fail=1 ;; esac
fi

exit "$fail"
