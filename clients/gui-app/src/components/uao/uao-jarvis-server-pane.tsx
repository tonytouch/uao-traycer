import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

export const JARVIS_PANE_ID = "jarvis";

/** Deep link into the backend's own Jarvis screen on the server. */
export function jarvisServerHref(jarvisUrl: string): string {
  return new URL("uao-api/#/jarvis", jarvisUrl).href;
}

/**
 * Jarvis (voice, provider failover) runs only on the server. The desktop does
 * not embed it; it opens the server's tailscale-served page in the browser,
 * where the microphone and speech recognition work.
 */
export function UaoJarvisServerPane({
  jarvisUrl,
}: {
  readonly jarvisUrl: string;
}) {
  const href = jarvisServerHref(jarvisUrl);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background p-6">
      <Mic className="size-6 text-muted-foreground" />
      <h2 className="font-heading text-ui-md font-bold">
        Jarvis runs on the server
      </h2>
      <p className="max-w-lg text-center text-ui-xs text-muted-foreground">
        Voice and provider failover live on the server, so Jarvis opens from
        its Tailscale address in your browser. Pair the browser once with the
        server&apos;s pairing link.
      </p>
      <p className="max-w-lg break-all text-center text-ui-xs text-muted-foreground">
        {href}
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          window.open(href, "_blank", "noopener,noreferrer");
        }}
      >
        Open Jarvis
      </Button>
    </div>
  );
}
