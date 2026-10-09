import { Component, type ErrorInfo, type ReactNode } from 'react';
import { House, RefreshCw, TriangleAlert } from 'lucide-react';
import './error-boundary.css';

interface Props {
  children: ReactNode;
  resetKey?: string | number;
}
interface State {
  hasError: boolean;
}

/** A failed render must never replace the workspace with a blank screen. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // No error messages, stack traces, customer data or credentials are exposed
    // by this fallback, and no external error-reporting request is made.
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="app-error-boundary" aria-labelledby="app-error-title" role="alert">
        <div className="app-error-content">
          <span className="app-error-symbol" aria-hidden="true">
            <TriangleAlert size={28} />
          </span>
          <p className="app-error-eyebrow">VENTURECORE INV</p>
          <h1 id="app-error-title">This page couldn’t load</h1>
          <p>
            Reload the page to try again, or return to the home page. Check your latest changes after
            reopening the workspace.
          </p>
          <div className="app-error-actions">
            <button type="button" className="button primary" onClick={() => window.location.reload()}>
              <RefreshCw size={16} />
              Reload page
            </button>
            <a className="button secondary" href="/">
              <House size={16} />
              Back to home
            </a>
          </div>
        </div>
      </section>
    );
  }
}
