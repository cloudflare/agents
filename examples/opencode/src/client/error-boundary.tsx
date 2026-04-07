import { Component, type ReactNode } from "react";
import { Button, Surface, Text } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches rendering errors in the React tree and shows a recovery UI
 * instead of a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-kumo-elevated p-8">
          <Surface className="max-w-lg w-full p-6 rounded-xl ring ring-kumo-line space-y-4">
            <div className="flex items-center gap-3">
              <WarningIcon
                size={24}
                weight="bold"
                className="text-kumo-danger shrink-0"
              />
              <Text size="lg" bold>
                Something went wrong
              </Text>
            </div>
            <div className="bg-kumo-elevated rounded-lg p-3 overflow-auto max-h-40">
              <Text size="xs" variant="secondary">
                <code className="font-mono whitespace-pre-wrap break-all">
                  {this.state.error.message}
                </code>
              </Text>
            </div>
            <div className="flex gap-3">
              <Button
                variant="primary"
                onClick={() => {
                  this.setState({ error: null });
                  window.location.reload();
                }}
              >
                Reload
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  localStorage.removeItem("opencode-session-id");
                  this.setState({ error: null });
                  window.location.reload();
                }}
              >
                New Session
              </Button>
            </div>
          </Surface>
        </div>
      );
    }

    return this.props.children;
  }
}
