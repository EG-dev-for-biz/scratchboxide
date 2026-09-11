/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import React from 'react';
import ReactDOM from 'react-dom/client';
import { installApiAuth } from '@scratchbox/core/common/api-client-config';
import App from './App';

// Attach the per-launch API token to same-origin API calls before anything fetches.
installApiAuth();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
