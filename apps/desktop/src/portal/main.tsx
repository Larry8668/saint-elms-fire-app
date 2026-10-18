import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles.css';
import { initAnalytics } from '@/lib/analytics';
import { PortalApp } from './PortalApp';

// A password-reset link carries its token in the address bar for the whole visit: never record one.
if (!new URLSearchParams(location.search).has('token')) initAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PortalApp />
  </StrictMode>,
);