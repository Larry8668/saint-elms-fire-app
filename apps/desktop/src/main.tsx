import '@fontsource-variable/inter';
import '@fontsource/instrument-serif';
import 'katex/dist/katex.min.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { App } from './app/App';
import { TooltipProvider } from './components/ui/overlays';
import { ChatProvider } from './features/teachers/chat-store';
import { NavProvider } from './lib/nav';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <NavProvider>
        <ChatProvider>
          <TooltipProvider delayDuration={200}>
            <App />
            <Toaster theme="dark" position="bottom-right" richColors />
          </TooltipProvider>
        </ChatProvider>
      </NavProvider>
    </QueryClientProvider>
  </StrictMode>,
);
