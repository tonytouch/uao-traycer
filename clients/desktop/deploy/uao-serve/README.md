# Hosting UAO for a phone (`uao-serve`)

Serves the UAO UI and its bounded backend proxy to a phone over the tailnet,
over HTTPS (needed for the microphone), behind a pairing secret.

```
phone (Tailscale) ──https:10000──▶ tailscale serve ──http──▶ 127.0.0.1:5191 uao-serve ──▶ 127.0.0.1:5050 Agent OS
```

## Design decisions

- **Loopback bind, not the Tailscale IP.** `tailscale serve` runs on this host
  and reaches `127.0.0.1`, so nothing else has to be able to open the port. A
  bind on `100.x` would also accept direct plain-HTTP dials. (The Host check
  would reject them, but the smaller surface is better.)
- **Pairing is the only gate.** The Agent OS backend exempts loopback callers
  that carry no forwarding headers, and `uao-serve` strips client
  `x-forwarded-*` before forwarding, so everything it proxies is treated as
  local. The unit refuses to start without the secret file.
- **Dedicated HTTPS port 10000.** Tailscale Serve only accepts HTTPS on 443,
  8443 or 10000. 8443 already has a listener on this host (checked
  2026-10-04), and 443 is left free for any future Serve mapping of the main
  Agent OS surface. `tailscale serve status` showed no config at that time.
- **systemd user unit, not pm2.** pm2 has had recurring boot-race breakages on
  this host. The unit caps memory at 256 MB; the host shares 22 GB with the
  agent fleet.
- **Never use `tailscale funnel`.** That would publish this to the internet.

## One-time setup

Check the box is calm and see what `tailscale serve` already maps (do not
proceed under heavy memory pressure):

```bash
cat /proc/pressure/memory          # "full avg10" should be near 0
tailscale serve status             # confirm :10000 is not already mapped
ss -ltn | grep ':10000 ' || echo 'port 10000 free'
```

Build and install (does not start anything):

```bash
cd ~/uao-traycer/clients/desktop
bun run build:uao:renderer && bun run build:uao:serve
./deploy/uao-serve/install.sh
# then check ~/.config/uao-serve/uao-serve.env: UAO_SERVE_ALLOWED_ORIGINS must be
# https://<this host's tailnet DNS name>:10000
```

## Start

```bash
systemctl --user enable --now uao-serve.service
journalctl --user -u uao-serve.service -n 20 --no-pager   # "uao-serve listening on http://127.0.0.1:5191 (pairing on, orca off)"
./deploy/uao-serve/verify.sh                               # loopback checks
```

Expose it on the tailnet (HTTPS certificate must be enabled for the tailnet in
the Tailscale admin console):

```bash
tailscale serve --bg --https=10000 http://127.0.0.1:5191
./deploy/uao-serve/verify.sh --tailnet
```

## Pair the phone

The pairing link contains the secret, so open it only on the phone and do not
paste it into chats or tickets:

```bash
echo "https://$(tailscale status --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'):10000/uao-pair?token=$(cat ~/.config/uao-serve/pairing-secret)"
```

Open it once in the phone browser (or the APK shell). It sets a one-year
`HttpOnly`, `SameSite=Strict`, `Secure` cookie and redirects to the UI.

## Rotate the secret

```bash
(umask 077 && node ~/uao-traycer/clients/desktop/dist/serve-uao/index.js --generate-secret > ~/.config/uao-serve/pairing-secret)
systemctl --user restart uao-serve.service
```

All previously paired devices are logged out; pair again.

## Roll back

```bash
tailscale serve --https=10000 off      # remove only this mapping; do NOT run `serve reset`
systemctl --user disable --now uao-serve.service
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Unit does not start, condition failed | no `pairing-secret`, or the renderer/serve bundle is not built |
| 403 "Invalid Host" through the tailnet | `UAO_SERVE_ALLOWED_ORIGINS` does not exactly match `https://<dns-name>:10000` |
| 401 after pairing | secret was rotated, or the cookie was dropped (cleared site data) |
| 429 on `/uao-pair` | 10 wrong tokens in a minute; wait 60 s (behind `tailscale serve` this is one shared counter) |
| 502 "UAO backend unreachable" | Agent OS on `127.0.0.1:5050` is down |
| No microphone prompt | page not served over HTTPS (open the `https://…:10000` URL, not the loopback one) |
