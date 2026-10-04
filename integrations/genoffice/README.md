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

GenOffice's document AI uses UAO's local CLI gateway by default. On the first
launch with this integration, Office selects the custom provider, chooses
`codex`, and disables Genspark cloud tools. Later explicit provider choices
are retained. The original GenOffice Home, cloud file browser and MCP service
are not started as a second app shell.

The desktop reads `~/.config/uao-office/gateway.json` (keep it mode `0600`):

```json
{
  "baseUrl": "http://127.0.0.1:8765/v1",
  "model": "codex",
  "token": "<existing local gateway token, or empty for anonymous gateways>"
}
```

`UAO_OFFICE_GATEWAY_CONFIG` selects another config file;
`UAO_OFFICE_GATEWAY_URL`, `UAO_OFFICE_GATEWAY_MODEL`, and
`LOCAL_GATEWAY_TOKEN` override its values. The model setting initializes the
Office selection; subsequent model changes in GenOffice settings persist.
The real token stays in main. GenOffice settings contain only the non-secret
`uao-local-gateway` marker. Requests carrying that marker use the configured
main-process endpoint, ignoring renderer-supplied URLs; redirects are refused.
The live model picker authenticates through the same main-process adapter.

This gateway fronts existing CLI logins, so no paid API key is needed, but
those accounts' usage limits still apply. The gateway is text-only: Office
supplies tool schemas in the prompt, validates the model's JSON tool names and
argument shape, and runs edits through GenOffice's existing document tool loop.
Tool results return on the next model turn. A reply the editor cannot act on
(not the JSON shape, or an unknown tool) is sent back to the model once with the
reason; nothing has executed at that point. A second failure is shown in the
panel and no edit is made. Text chat, writing, rewriting, and document edits are
supported; image/video analysis and image generation are not supplied by this
connection. CLI answers arrive as a completed turn rather than token-by-token.

Stop cancels the request end to end. Each request carries an id, and the
desktop calls `POST /v1/requests/<id>/cancel` on the gateway, which terminates
the CLI's whole process group. This needs the gateway patch in
`gateway-cancellation.patch` (which also pins the Codex model, default `gpt-6-astra`, overridable with `LOCAL_GATEWAY_CODEX_MODEL`; tests: `python3 test_gateway_cancellation.py`);
without it Stop only abandons the wait and the gateway's own timeout bounds the
CLI. The HTTP-bridge model `freebuff` cannot be cancelled and reports
`"cancellable": false` in `/v1/models`.

Broken AI configuration never stops UAO from opening. An unreadable
`ai-settings.json` is kept as `ai-settings.json.corrupt-<time>` and reset; an
unreadable gateway file leaves the editors usable, logs a warning, and makes the
AI panel report the configuration error instead of a Genspark sign-in prompt.
The editors' release renderers hard-code a "Genspark" title, so Office rewrites
it at runtime to `Local AI · <model>` while the gateway provider is selected
(`branding.ts`).

For isolated package verification, `UAO_DESKTOP_USER_DATA` can select a
scratch profile and `UAO_DESKTOP_PORT` a separate local port. These leave the
normal `uao-desktop` profile and port 5183 unchanged.
