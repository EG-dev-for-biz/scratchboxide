/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React from 'react';
import ReactDOM from 'react-dom/client';
import { installApiAuth } from '@scratchbox/core/common/api-client-config';
import '@scratchbox/core/style.css';
import App from './App';

// Ensure apiBase is configured when running under browser or Vite dev server
if (typeof window !== 'undefined') {
  const win = window as any;
  const defaultApiBase = `http://127.0.0.1:${(typeof process !== 'undefined' && process.env?.SCRATCHBOX_API_PORT) || '3001'}`;
  const envLaunchToken = (typeof process !== 'undefined' && process.env?.SCRATCHBOX_LAUNCH_TOKEN) || '';
  if (!win.scratchbox) {
    win.scratchbox = {
      apiBase: defaultApiBase,
      ...(envLaunchToken ? { launchToken: envLaunchToken } : {})
    };
  } else {
    if (!win.scratchbox.apiBase) win.scratchbox.apiBase = defaultApiBase;
    if (!win.scratchbox.launchToken && envLaunchToken) win.scratchbox.launchToken = envLaunchToken;
  }
}

// Attach the per-launch API token to same-origin API calls before anything fetches.
installApiAuth();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
