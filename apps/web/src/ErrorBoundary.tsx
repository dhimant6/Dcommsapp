import { Component, ReactNode } from 'react';

/**
 * Last-resort crash surface. Without this, any render-time exception unmounts
 * the whole React tree and the user sees a BLANK PAGE with the real error
 * hidden in a console they'll never open. With it, the error text is on
 * screen — turning "it went blank" bug reports into copy-pasteable messages.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-page">
        <div className="card" style={{ maxWidth: 560 }}>
          <h3>Something broke</h3>
          <p className="error" style={{ wordBreak: 'break-word' }}>
            {this.state.error.message}
          </p>
          <pre className="muted" style={{ fontSize: 11, overflow: 'auto', maxHeight: 160 }}>
            {this.state.error.stack}
          </pre>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
