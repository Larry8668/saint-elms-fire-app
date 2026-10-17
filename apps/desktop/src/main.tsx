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
import { takeWorkspaceFromUrl } from './lib/seat';
import { SessionProvider } from './lib/session';

// The portal hands a student's workspace over as ?workspace=<VM url>; read it before anything calls the engine.
takeWorkspaceFromUrl({ href: location.href, replaceUrl: (url) => history.replaceState(history.state, '', url) });

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
