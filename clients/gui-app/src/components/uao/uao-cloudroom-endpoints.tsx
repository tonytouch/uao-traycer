import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { getCloudroomApi } from "@/lib/uao/cloudroom";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  type CloudroomPublicConfig,
} from "@traycer-clients/shared/cloudroom";

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

export function UaoCloudroomEndpoints({
  config,
  onSaved,
}: {
  readonly config: CloudroomPublicConfig;
  readonly onSaved: () => Promise<void>;
}) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationKey: uaoQueryKeys.cloudroomSave(),
    mutationFn: async () => {
      const api = getCloudroomApi();
      await api.setConfig({ baseUrl });
      const value = token.trim();
      if (value !== "") {
        const result = await api.setToken(value);
        if (!result.ok) throw new Error(result.error);
      }
      await onSaved();
    },
    onSuccess: () => {
      setToken("");
    },
  });
  const clearToken = useMutation({
    mutationKey: uaoQueryKeys.cloudroomToken(),
    mutationFn: async () => {
      const result = await getCloudroomApi().setToken("");
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
        UAO talks to CloudRoom on the Tailscale host. It does not install or
        start that server. Paste the server token. A new Tailscale http://100.x
        address is allowed as cleartext on the next launch.
      </p>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-cloudroom-base"
      >
        CloudRoom
        <input
          id="uao-cloudroom-base"
          value={baseUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={CLOUDROOM_DEFAULT_BASE_URL}
          onChange={(event) => setBaseUrl(event.currentTarget.value)}
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-cloudroom-token"
      >
        CloudRoom token
        {config.tokenSaved ? " (saved)" : ""}
        <span className="flex items-center gap-2">
          <input
            id="uao-cloudroom-token"
            type="password"
            autoComplete="off"
            value={token}
            placeholder={
              config.tokenSaved ? "Saved in the keychain" : "Enter token"
            }
            onChange={(event) => setToken(event.currentTarget.value)}
            className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
          />
          {config.tokenSaved ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                clearToken.mutate();
              }}
            >
              Remove
            </Button>
          ) : null}
        </span>
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
          onClick={() => setBaseUrl(CLOUDROOM_DEFAULT_BASE_URL)}
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
