import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { startRealtime } from './lib/realtimeBridge';
import { invalidateAll } from './lib/queryCache';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

startRealtime();

// Return to the dashboard → immediately revalidate everything, so a change
// that happened while the tab was backgrounded is never hidden behind a
// TTL. Mounted views re-fetch in the background and swap in fresh data.
function onReturn() {
  if (document.visibilityState === 'hidden') return;
  invalidateAll();
}
window.addEventListener('focus', onReturn);
document.addEventListener('visibilitychange', onReturn);
window.addEventListener('pageshow', onReturn);
