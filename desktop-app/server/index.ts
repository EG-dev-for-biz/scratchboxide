/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createStandaloneServer } from './app';
import * as path from 'path';

const PORT = parseInt(process.env.PORT || '3001', 10);
const staticDir = path.resolve(__dirname, '../dist');

const app = createStandaloneServer({
    port: PORT,
    staticDir
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Scratchbox Standalone Backend API listening on http://127.0.0.1:${PORT}`);
});
