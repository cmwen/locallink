import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import '@cmwen/min-design-system/forest-and-fern.css';
import './styles.css';

// Set the palette before the first render to avoid a light-theme flash.
let initialTheme = 'dark';
try { initialTheme = localStorage.getItem('locallink-theme') === 'light' ? 'light' : 'dark'; } catch { /* Storage may be unavailable in private browsing. */ }
document.documentElement.dataset.theme = initialTheme;
document.documentElement.dataset.ffTheme = initialTheme;

const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
