import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Register service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const { Workbox } = await import('workbox-window');
      const wb = new Workbox('/service-worker.js');

      wb.addEventListener('waiting', () => {
        // Show a prompt to user to refresh/update the app
        if (confirm('New app update is available! Click OK to refresh')) {
          wb.messageSkipWaiting();
          window.location.reload();
        }
      });

      wb.addEventListener('controlling', () => {
        window.location.reload();
      });

      await wb.register();
    } catch (error) {
      console.error('Service worker registration failed:', error);
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);