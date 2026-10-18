import '@fontsource-variable/inter';
import '@fontsource/instrument-serif';
import 'katex/dist/katex.min.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { Root } from './app/Root';
import { TooltipProvider } from './components/ui/overlays';
import { initAnalytics } from './lib/analytics';
import { takeWorkspaceFromUrl, workspaceDemoPersona } from './lib/seat';
import { requestTour } from './features/tour/tour-state';
import { SessionProvider } from './lib/session';

// The portal hands a student's workspace over as ?workspace=<VM url>; read it before anything calls the engine.
const intake = takeWorkspaceFromUrl({ href: location.href, replaceUrl: (url) => history.replaceState(history.state, '', url) });
// A demo hand-off asks for the tour on every arrival, even when this browser is already signed in
// as that student (judges share laptops): the dashboard consumes the request once it is up.
if (intake === 'stored' && workspaceDemoPersona()) requestTour();
// After the hand-off: the first pageview is recorded without the workspace URL in it.
initAnalytics();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider delayDuration={200}>
          <Root />
          <Toaster theme="dark" position="bottom-right" richColors />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
