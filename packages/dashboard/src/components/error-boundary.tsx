import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-bg-base flex items-center justify-center">
          <div className="max-w-md text-center space-y-4">
            <h1 className="text-lg font-semibold text-text-primary">Something went wrong</h1>
            <p className="text-sm text-text-muted">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <pre className="text-xs text-text-tertiary bg-bg-surface rounded p-3 max-h-40 overflow-auto text-left">
              {this.state.error?.stack}
            </pre>
            <button
              type="button"
              onClick={this.handleReset}
              className="px-4 py-2 rounded-md bg-brand text-white text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
