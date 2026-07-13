import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// theme.css MUST load first: it defines the 12 palettes and the :root theme
// variables (--bg, --t1, --ac, --glass-*, ...) that global.css, App.css and
// every component stylesheet consume. Without it those variables are undefined,
// so backgrounds/text collapse to transparent and the whole UI renders black
// and unreadable.
import './styles/theme.css';
import './styles/global.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
