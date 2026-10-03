# GenOffice in UAO

Office is the document workspace in UAO's existing desktop window. It hosts
GenOffice's native Docs, Sheets, Slides, PDF, Markdown and HTML views. Open
documents stay mounted when another UAO feature is selected. GenOffice owns
the format engines, file saves, recovery and unsaved-changes prompts.

Second Brain remains the knowledge vault. UAO and Orca continue to own task
chat, agent execution, workspaces and terminals. The Office integration does
not change the original UAO or Orca checkout.

The Apache-2.0 source is a submodule pinned to GenOffice v0.11.0
(`21111196b40a01e70760602729fbac16f1b86008`). Editor renderers and native engines
are staged from the same release's Linux x64 AppImage, verified with SHA-256
`8982828d87c515ee18cdf7b3c5a86109bc0c97e16f9019288191929e1c4e416c`.
Licenses, NOTICE, third-party notices and Unicode attribution ship alongside
the engines. Upstream source is not patched; the bundle adapts its tab
manager's placement and visibility to the UAO panel.

Build the current Linux x64 package with `bun run package:uao` in
`clients/desktop`. The build initializes the pinned submodule if needed,
installs its locked dependencies without install scripts, downloads and
verifies the matching release, then stages the Office resources. Once built,
the AppImage serves its compiled UAO renderer locally; it needs no Vite
server, Traycer Host or Traycer cloud login. UAO's existing backend still
supplies the UAO screens and Orca runtime.

GenOffice's document AI handlers are retained. They use GenOffice's own
provider configuration and optional Genspark login; UAO does not configure
credentials or initiate paid AI requests. The original GenOffice Home,
cloud file browser and MCP service are not started as a second app shell.

For isolated package verification, `UAO_DESKTOP_USER_DATA` can select a
scratch profile and `UAO_DESKTOP_PORT` a separate local port. These leave the
normal `uao-desktop` profile and port 5183 unchanged.
