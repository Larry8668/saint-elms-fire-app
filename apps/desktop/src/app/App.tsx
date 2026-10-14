import { AnimatePresence, motion } from 'motion/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrainView } from '@/features/brain/BrainView';
import { CaptureView } from '@/features/capture/CaptureView';
import { LibraryView } from '@/features/library/LibraryView';
import { SettingsView } from '@/features/settings/SettingsView';
import { SkyView } from '@/features/sky/SkyView';
import { TeachersView } from '@/features/teachers/TeachersView';
import { log } from '@/lib/log';
import { useNav, type View } from '@/lib/nav';
import { Sidebar } from './Sidebar';

const VIEWS: Record<View, () => ReactNode> = {
  sky: SkyView,
  teachers: TeachersView,
  capture: CaptureView,
  brain: BrainView,
  library: LibraryView,
  settings: SettingsView,
};

export function App() {
  const { view } = useNav();
  const Current = VIEWS[view];
  return (
    <div className="flex h-screen overflow-hidden bg-night-950 text-night-100">
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div key={view} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <ViewBoundary view={view}>
              <Current />
            </ViewBoundary>
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

/** Keeps one broken view (e.g. a WebGL failure in the sky) from blanking the whole app. */
class ViewBoundary extends Component<{ view: View; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('view_crashed', { view: this.props.view, error: error.message, stack: info.componentStack });
  }

  componentDidUpdate(prev: { view: View }) {
    if (prev.view !== this.props.view && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <h2 className="font-display text-3xl text-night-100">This view hit a problem</h2>
          <p className="mt-2 text-sm text-night-400">{this.state.error.message}</p>
          <button className="mt-4 text-sm text-beacon-300 underline" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
