# UAO desktop on macOS

`install.sh` builds the UAO desktop for macOS arm64 on this (Linux) box, ships
it to a Mac, ad-hoc signs it there, points it at a remote UAO backend and
relaunches it.

```sh
./install.sh                              # Mac mini over Tailscale, backend = this box
MAC_HOST=tony@other-mac BACKEND_HOST=100.90.167.20 ./install.sh
SKIP_BUILD=1 ./install.sh                 # reinstall the last build
```

- The Mac app dials the backend over the network, so it needs the backend up
  (`:5050` accepts tailnet sources without a token). Config is written to
  `~/Library/Application Support/uao-desktop/backend.json`; `UAO_BACKEND_HOST`
  / `UAO_BACKEND_PORT` override it.
- Installs to `~/Applications/UAO.app`. An older Orca-based `/Applications/UAO.app`
  is left alone.
- Requires key-based SSH to the Mac. Office/GenOffice is not bundled on macOS.
- Ad-hoc signing only: no notarization, and first launch can take ~30 s on a
  Mac that is short of memory.
