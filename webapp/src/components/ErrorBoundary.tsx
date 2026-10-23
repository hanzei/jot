import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  componentStack: string | null;
  reset: () => void;
}

interface ErrorBoundaryProps {
  /** Shown in place of the subtree once it has thrown during render. */
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode;
  /** Names the boundary in the logged error, so the console says which one caught it. */
  name: string;
  /** Changing this clears a caught error, e.g. the route, so navigating away recovers. */
  resetKey?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  resetKey: string | undefined;
}

/** Something other than an Error can be thrown; normalize so the fallback always has a message. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Catches render errors in its subtree and shows `fallback` instead of a blank page. */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, componentStack: null, resetKey: props.resetKey };
    }
    return null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error(`Render error caught by ${this.props.name} error boundary:`, toError(error));
  }

  private reset = () => {
    this.setState({ error: null, componentStack: null });
  };

  override render() {
    const { error, componentStack } = this.state;
    if (error) {
      return this.props.fallback({ error, componentStack, reset: this.reset });
    }
    return this.props.children;
  }
}
