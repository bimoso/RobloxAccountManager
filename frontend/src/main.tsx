// Base styles load BEFORE the app so every component and page stylesheet comes
// later in the cascade and can refine the shared primitives at equal
// specificity. (When the primitives loaded last they silently beat page rules —
// that is how the Charts tabs ended up floating mid-page.)
//
// Fonts are bundled, so the interface renders identically offline.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/bricolage-grotesque/standard.css';
// theme.css defines the palettes and every token the rest of the CSS consumes.
import './styles/theme.css';
import './styles/global.css';
import './styles/rackline.css';
import './styles/form-modal.css';
import './styles/shell.css';
import './styles/alive.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

/**
 * Renders the app.
 *
 * Outside the Tauri webview there is no `window.api`, so in a dev server the
 * in-memory mock bridge is installed first — otherwise the Encryption_Gate init
 * throws on its first IPC call and nothing renders. The import is dynamic and
 * behind `import.meta.env.DEV`, so Vite drops the whole branch (and the module)
 * from the production bundle that ships inside Tauri.
 */
async function start(): Promise<void> {
  if (import.meta.env.DEV && !window.api) {
    const { installMockApi } = await import('./dev/mockApi');
    installMockApi();
  }

  ReactDOM.createRoot(rootElement!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
