import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { getOpenMuseApi } from "@/lib/uao/openmuse";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
  type OpenMuseEndpointConfig,
} from "@traycer-clients/shared/openmuse";

function endpointFormMessage(
  saved: boolean,
  saveError: unknown,
): string | null {
  if (saved) return "Saved.";
  if (saveError instanceof Error) return saveError.message;
  return null;
}

export function UaoOpenMuseEndpoints({
  config,
  onSaved,
}: {
  readonly config: OpenMuseEndpointConfig;
  readonly onSaved: () => Promise<void>;
}) {
  const [webUrl, setWebUrl] = useState(config.webUrl);
  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const save = useMutation({
    mutationKey: uaoQueryKeys.openmuseSave(),
    mutationFn: async () => {
      await getOpenMuseApi().setConfig({ webUrl, apiUrl });
      await onSaved();
    },
  });
  const message = endpointFormMessage(save.isSuccess, save.error);

  return (
    <form
      className="flex max-h-1/2 flex-col gap-3 overflow-y-auto border-b border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-ui-sm text-muted-foreground">
        UAO embeds the OpenMuse web app. It does not install or start that
        server, and it does not store the access key. Live mode asks for the key
        inside the page. Clear the web URL to hide OpenMuse in the sidebar while
        this tab stays open. A new Tailscale http://100.x address is allowed as
        cleartext on the next launch.
      </p>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-openmuse-web"
      >
        OpenMuse web
        <input
          id="uao-openmuse-web"
          value={webUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Leave empty to hide OpenMuse"
          onChange={(event) => setWebUrl(event.currentTarget.value)}
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      <label
        className="flex flex-col gap-1 text-ui-sm"
        htmlFor="uao-openmuse-api"
      >
        OpenMuse API
        <input
          id="uao-openmuse-api"
          value={apiUrl}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Must match EXPO_PUBLIC_API_URL"
          onChange={(event) => setApiUrl(event.currentTarget.value)}
          className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="default"
          size="sm"
          disabled={save.isPending}
        >
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            setWebUrl(OPENMUSE_DEFAULT_WEB_URL);
            setApiUrl(OPENMUSE_DEFAULT_API_URL);
          }}
        >
          Use Tailscale defaults
        </Button>
        {save.isPending ? (
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
