import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * One bad render must not take the whole app with it.
 *
 * React unmounts the entire tree when a render throws, so a single malformed
 * stored doc — a portal whose target vanished, a node attribute from a newer
 * version, a query block with something unexpected in it — produced a white
 * screen with no route back. Worse, the view used to live in React state, so
 * reloading returned you to the same broken rem; that part is fixed now the
 * route is in the URL, but only if there is something left on screen to click.
 *
 * The boundary wraps the document area rather than the app, so the sidebar,
 * the tabs and the URL bar all keep working: whatever broke, you can still
 * walk away from it.
 *
 * It is given a `key` derived from the route, so navigating anywhere else
 * remounts it with a clean slate. Clearing the error inside `componentDidUpdate`
 * would do the same thing by hand, one render later, and is the pattern React
 * specifically warns about.
 */

interface Props {
  children: ReactNode;
  /** Somewhere safe to send the user. */
  onEscape?: () => void;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' });
    // Kept in the console as well as on screen: the copy button is the useful
    // path, but a stack that only exists behind a button is easy to lose.
    console.error('Clemnotes render error', error, info);
  }

  private diagnostics(): string {
    const { error, info } = this.state;
    return [
      `Clemnotes render error`,
      `When: ${new Date().toISOString()}`,
      `Where: ${window.location.hash || '#/notes'}`,
      `Error: ${error?.name}: ${error?.message}`,
      '',
      error?.stack ?? '(no stack)',
      '',
      'Component stack:',
      info || '(none)',
    ].join('\n');
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h2>This rem wouldn’t render</h2>
        <p>
          Something in the content here threw while drawing. Nothing has been lost — the rem is
          still in the database exactly as it was, and everything else still works.
        </p>
        <pre className="crash-message">
          {error.name}: {error.message}
        </pre>
        <div className="crash-actions">
          {this.props.onEscape && (
            <button type="button" className="primary-btn" onClick={this.props.onEscape}>
              Go to another page
            </button>
          )}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => this.setState({ error: null, info: '' })}
          >
            Try again
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void navigator.clipboard?.writeText(this.diagnostics())}
          >
            Copy diagnostics
          </button>
        </div>
        <p className="crash-note">
          If it keeps happening, <strong>Export &amp; backup</strong> in the sidebar still works —
          take a copy before trying to fix anything.
        </p>
      </div>
    );
  }
}
