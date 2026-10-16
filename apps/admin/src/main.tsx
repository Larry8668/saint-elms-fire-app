import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './AdminApp';
import { log } from '@/lib/log';
import './styles.css';

/** A crash anywhere in the registrar must not blank the page: the panel survives and reloads. */
class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('admin_view_crashed', { error: error.message, stack: info.componentStack });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center p-8 text-center">
        <div>
          <h2 className="font-display text-3xl text-night-100">The registrar hit a problem</h2>
          <p className="mt-2 text-sm text-night-400">{this.state.error.message}</p>
          <button
            type="button"
            className="mt-4 rounded-xl border border-white/10 px-4 py-2 text-[13px] text-night-200 hover:border-beacon-400/40"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootBoundary>
      <AdminApp />
    </RootBoundary>
  </StrictMode>,
);
