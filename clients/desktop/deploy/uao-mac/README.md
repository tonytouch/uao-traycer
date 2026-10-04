# UAO desktop on macOS

`install.sh` builds the UAO desktop for macOS arm64 on this (Linux) box, ships
it to a Mac, ad-hoc signs it there, points it at a remote UAO backend and
relaunches it.

```sh
./install.sh                              # Mac mini over Tailscale, backend = this box
MAC_HOST=tony@other-mac BACKEND_HOST=100.90.167.20 ./install.sh
SKIP_BUILD=1 ./install.sh                 # reinstall the last build
```

- The Mac app reaches the backend through this box's `tailscale serve` gateway
  (`uao-serve`, `:10000`) with the pairing secret, because the butler (Jarvis
  /ask and /speak) answers loopback callers only and the gateway is one. The
  secret is copied to `~/Library/Application Support/uao-desktop/pairing-secret`
  (mode 600) and never printed. Config lives in `backend.json` next to it
  (`{"upstream": "https://<name>.ts.net:10000/"}`); `UAO_UPSTREAM` /
  `UAO_PAIRING_SECRET` override. `UPSTREAM=` (empty) dials the backend directly
  instead, where everything except Jarvis' /ask and /speak works.
- Installs to `~/Applications/UAO.app`. An older Orca-based `/Applications/UAO.app`
  is left alone.
- Requires key-based SSH to the Mac. Office/GenOffice is not bundled on macOS.
- Ad-hoc signing only: no notarization, and first launch can take ~30 s on a
  Mac that is short of memory.
