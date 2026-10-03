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

// Attach the per-launch API token to same-origin API calls before anything fetches.
installApiAuth();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
