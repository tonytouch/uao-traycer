import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { getAgentOsApi } from "@/lib/uao/agent-os";
import {
  AGENT_OS_DEFAULT_ENDPOINTS,
  AGENT_OS_TOKEN_SERVICES,
  type AgentOsEndpointConfig,
  type AgentOsPublicConfig,
  type AgentOsTokenService,
} from "@traycer-clients/shared/agent-os-endpoints";

const TOKEN_FIELDS: readonly {
  readonly service: AgentOsTokenService;
  readonly label: string;
}[] = [
  { service: "agent-os", label: "Agent OS token" },
  { service: "hermes", label: "Hermes token" },
  { service: "omniroute", label: "Omniroute token" },
];

function emptyTokens(): Record<AgentOsTokenService, string> {
  return { "agent-os": "", hermes: "", omniroute: "" };
}

function endpointFormMessage(
  saved: boolean,
  saveError: unknown,
  clearError: unknown,
): string | null {
  if (saved) return "Saved. Tokens stay in the OS keychain.";
  if (saveError instanceof Error) return saveError.message;
  if (clearError instanceof Error) return clearError.message;
  return null;
}

function endpointDraft(config: AgentOsPublicConfig): AgentOsEndpointConfig {
  return {
    baseUrl: config.baseUrl,
    hermesUrl: config.hermesUrl,
    omnirouteUrl: config.omnirouteUrl,
    localSupervisor: config.localSupervisor,
  };
}

export function UaoAgentOsEndpoints({
  config,
  onSaved,
}: {
  readonly config: AgentOsPublicConfig;
  readonly onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentOsEndpointConfig>(() =>
    endpointDraft(config),
  );
  const [tokens, setTokens] =
    useState<Record<AgentOsTokenService, string>>(emptyTokens);
  const save = useMutation({
    mutationKey: uaoQueryKeys.agentOsSave(),
    mutationFn: async () => {
      const api = getAgentOsApi();
      await api.setConfig(draft);
      for (const service of AGENT_OS_TOKEN_SERVICES) {
        const value = tokens[service].trim();
        if (value === "") continue;
        const result = await api.setToken(service, value);
        if (!result.ok) throw new Error(result.error);
      }
      await onSaved();
    },
    onSuccess: () => {
      setTokens(emptyTokens());
    },
  });
  const clearToken = useMutation({
    mutationKey: uaoQueryKeys.agentOsToken(),
    mutationFn: async (service: AgentOsTokenService) => {
      const result = await getAgentOsApi().setToken(service, "");
      if (!result.ok) throw new Error(result.error);
      await onSaved();
    },
  });
  const pending = save.isPending || clearToken.isPending;
  const message = endpointFormMessage(
    save.isSuccess,
    save.error,
    clearToken.error,
  );

  return (
    <form
      className="flex max-h-1/2 flex-col gap-3 overflow-y-auto border-b border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-ui-sm text-muted-foreground">
        UAO opens Agent OS on the Tailscale host. It does not start that server.
        A new Tailscale http://100.x address is allowed as cleartext on the next
        launch.
      </p>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-agent-os-base"
      >
        Agent OS
        <input
          id="uao-agent-os-base"
          value={draft.baseUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) =>
            setDraft({ ...draft, baseUrl: event.currentTarget.value })
          }
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-agent-os-hermes"
      >
        Hermes
        <input
          id="uao-agent-os-hermes"
          value={draft.hermesUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) =>
            setDraft({ ...draft, hermesUrl: event.currentTarget.value })
          }
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-agent-os-omniroute"
      >
        Omniroute
        <input
          id="uao-agent-os-omniroute"
          value={draft.omnirouteUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) =>
            setDraft({ ...draft, omnirouteUrl: event.currentTarget.value })
          }
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      {TOKEN_FIELDS.map((field) => (
        <label
          key={field.service}
          className="flex flex-col gap-1 text-ui-sm"
          htmlFor={`uao-token-${field.service}`}
        >
          {field.label}
          {config.tokens[field.service] ? " (saved)" : ""}
          <span className="flex items-center gap-2">
            <input
              id={`uao-token-${field.service}`}
              type="password"
              autoComplete="off"
              value={tokens[field.service]}
              placeholder={
                config.tokens[field.service]
                  ? "Saved in the keychain"
                  : "Enter token"
              }
              onChange={(event) =>
                setTokens({
                  ...tokens,
                  [field.service]: event.currentTarget.value,
                })
              }
              className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
            />
            {config.tokens[field.service] ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  clearToken.mutate(field.service);
                }}
              >
                Remove
              </Button>
            ) : null}
          </span>
        </label>
      ))}
      <label
        className="flex items-center gap-2 text-ui-sm"
        htmlFor="uao-agent-os-local"
      >
        <input
          id="uao-agent-os-local"
          type="checkbox"
          checked={draft.localSupervisor}
          onChange={(event) =>
            setDraft({ ...draft, localSupervisor: event.currentTarget.checked })
          }
        />
        Use a local Agent OS already running on this machine (127.0.0.1:5050).
        UAO does not start it.
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="default" size="sm" disabled={pending}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setDraft(AGENT_OS_DEFAULT_ENDPOINTS)}
        >
          Use Tailscale defaults
        </Button>
        {pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </div>
      {message !== null ? (
        <p className="text-ui-sm text-muted-foreground">{message}</p>
      ) : null}
    </form>
  );
}
