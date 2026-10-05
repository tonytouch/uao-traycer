import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { appLogger } from "@/lib/logger";

interface UaoPaneBoundaryProps {
  /** Pane name, shown in the fallback and the log line. */
  readonly label: string;
  readonly children: ReactNode;
}

interface UaoPaneBoundaryState {
  readonly error: Error | null;
}

/**
 * Keeps one crashing UAO pane from unmounting the whole desktop. Without it, a
 * render error in any native pane (for example Workspace's terminal list) blanks the
 * window, closing every other tab and discarding its state.
 */
export class UaoPaneBoundary extends Component<
  UaoPaneBoundaryProps,
  UaoPaneBoundaryState
> {
  constructor(props: UaoPaneBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): UaoPaneBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    appLogger.errorSummary(
      "[uao] pane crashed",
      { pane: this.props.label, componentStack: info.componentStack ?? null },
      error,
    );
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="font-heading text-ui-md font-semibold">
          {this.props.label} hit an error
        </p>
        <p className="max-w-md text-ui-xs text-muted-foreground">
          The rest of UAO is unaffected. Retry to reload this screen.
        </p>
        <Button size="sm" variant="outline" onClick={this.retry}>
          Retry
        </Button>
      </div>
    );
  }
}
