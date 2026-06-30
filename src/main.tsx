import React, {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { patchBrowserDialogsForAutoTranslation, patchReactForAutoTranslation } from './i18n/runtimeAutoTranslate';

patchReactForAutoTranslation();
patchBrowserDialogsForAutoTranslation();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
