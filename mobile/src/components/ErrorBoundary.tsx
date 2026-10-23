import React from 'react';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  componentStack: string | null;
  reset: () => void;
}

interface ErrorBoundaryProps {
  /** Shown in place of the subtree once it has thrown during render. */
  fallback: (props: ErrorBoundaryFallbackProps) => React.ReactNode;
  /** Names the boundary in the logged error, so a report says which one caught it. */
  name: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** Something other than an Error can be thrown; normalize so the fallback always has a message. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Catches render errors in its subtree and shows `fallback` instead of a white
 * screen. The error is logged with console.error, which the logger persists, so
 * it survives a restart and ships in the diagnostics report.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(error) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo) {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack });
    // Error and component stack only: props and state can hold note content.
    console.error(`Render error caught by ${this.props.name} error boundary:`, toError(error), componentStack ?? '');
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
