import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from '@/components/ErrorBoundary';
import ErrorFallback from '@/components/ErrorFallback';
import './index.css';

// Register service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const { Workbox } = await import('workbox-window');
      const wb = new Workbox('/service-worker.js');

      wb.addEventListener('controlling', (event) => {
        // Only an update needs the reload. On a first-ever install the worker
        // claims a page that is already running the build it just precached,
        // so reloading there is a visible flash that changes nothing.
        if (event.isUpdate) {
          window.location.reload();
        }
      });

      await wb.register();

      // Check for updates every 60 minutes so long-running sessions pick up new deployments.
      setInterval(() => wb.update(), 60 * 60 * 1000);
    } catch (error) {
      console.error('Service worker registration failed:', error);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Outermost, so a render error anywhere shows the fallback instead of a blank page. */}
    <ErrorBoundary name="root" fallback={(props) => <ErrorFallback {...props} variant="root" />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);