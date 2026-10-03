import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, X } from "lucide-react";
import type { OfficeKind } from "@traycer-clients/shared/uao-office";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { getOfficeApi, officeQueryOptions } from "@/lib/uao/office";

const editors: readonly { readonly kind: OfficeKind; readonly label: string; readonly format: string }[] = [
  { kind: "docs", label: "Docs", format: ".docx" },
  { kind: "sheets", label: "Sheets", format: ".xlsx" },
  { kind: "slides", label: "Slides", format: ".pptx" },
  { kind: "pdf", label: "PDF", format: ".pdf" },
  { kind: "markdown", label: "Markdown", format: ".md" },
  { kind: "html", label: "HTML", format: ".html" },
];
type OfficeAction = { readonly action: "create"; readonly kind: OfficeKind }
  | { readonly action: "browse" }
  | { readonly action: "activate" | "close"; readonly id: string };

export function UaoOfficePane({ active }: { readonly active: boolean }) {
  const client = useQueryClient();
  const surface = useRef<HTMLDivElement | null>(null);
  const documents = useQuery(officeQueryOptions());
  const action = useMutation({ mutationKey: uaoQueryKeys.officeAction(),
    mutationFn: async (request: OfficeAction) => {
      const api = getOfficeApi();
      if (request.action === "create") await api.create(request.kind);
      else if (request.action === "browse") await api.browse();
      else if (request.action === "activate") await api.activate(request.id);
      else await api.close(request.id);
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: uaoQueryKeys.office() }); },
  });
  useEffect(() => {
    if (!window.uaoOffice) return;
    return window.uaoOffice.onChanged(() => {
      void client.invalidateQueries({ queryKey: uaoQueryKeys.office() });
    });
  }, [client]);
  useEffect(() => {
    const api = window.uaoOffice;
    const element = surface.current;
    if (!api || !element) return;
    const update = () => {
      if (!active) { api.setViewport(null); return; }
      const rect = element.getBoundingClientRect();
      api.setViewport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); api.setViewport(null); };
  }, [active]);
  const tabs = documents.data ?? [];
  const selected = tabs.find(tab => tab.active);
  const error = action.error ?? documents.error;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="mr-auto flex items-center gap-2">
          <FileText className="size-5 text-primary" />
          <div><h2 className="font-heading text-ui-md font-semibold">Office</h2>
            <p className="text-ui-xs text-muted-foreground">Local documents · Powered by GenOffice</p></div>
        </div>
        {editors.map(editor => <TooltipWrapper key={editor.kind} label={`New ${editor.format} document`}>
          <Button size="sm" variant="outline"
          disabled={action.isPending || documents.isError}
          onClick={() => { action.mutate({ action: "create", kind: editor.kind }); }}>
          {editor.label}
        </Button></TooltipWrapper>)}
        <Button size="sm" variant="default" disabled={action.isPending || documents.isError}
          onClick={() => { action.mutate({ action: "browse" }); }}>
          <FolderOpen /> Open file
        </Button>
        {action.isPending ? <AgentSpinningDots /> : null}
      </div>
      {error ? <div role="alert" className="border-b p-3 text-ui-sm text-destructive">
        {error.message}
        <Button variant="outline" size="sm" onClick={() => { action.reset(); void documents.refetch(); }}>Retry</Button>
      </div> : null}
      <div role="tablist" aria-label="Office documents" className="flex shrink-0 gap-1 overflow-x-auto border-b p-2">
        {tabs.map(tab => <div key={tab.id} className="flex shrink-0 items-center gap-1">
          <TooltipWrapper label={tab.filePath ?? tab.title}><button type="button" role="tab" aria-selected={tab.active}
            className={cn("rounded-md px-3 py-2 text-ui-xs", tab.active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent")}
            disabled={action.isPending} onClick={() => { action.mutate({ action: "activate", id: tab.id }); }}
            >{tab.kind === "home" ? "Office home" : tab.title}</button></TooltipWrapper>
          {tab.closable ? <Button size="icon-sm" variant="ghost" aria-label={`Close ${tab.title}`}
            disabled={action.isPending} onClick={() => { action.mutate({ action: "close", id: tab.id }); }}><X /></Button> : null}
        </div>)}
      </div>
      <div ref={surface} className="relative min-h-0 flex-1">
        {documents.isPending ? <div role="status" className="flex h-full items-center justify-center"><AgentSpinningDots /></div> : null}
        {!documents.isPending && (!selected || selected.kind === "home") ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 overflow-auto p-6 text-center">
            <FileText className="size-10 text-muted-foreground" />
            <div><h3 className="font-heading text-ui-lg font-semibold">Your document workspace</h3>
              <p className="mt-2 max-w-prose text-ui-sm text-muted-foreground">Create or open Word documents, spreadsheets, presentations, PDFs, Markdown and HTML. Documents stay open when you switch to other UAO tabs.</p></div>
            <p className="max-w-prose text-ui-xs text-muted-foreground">Second Brain keeps your knowledge and notes. Office edits your files. AI tools use the provider you configure in the editor.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
