/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as os from 'os';
import * as path from 'path';

/**
 * The user's Scratchbox home: where the app keeps what must outlive any one checkout of the code (the durable asset
 * store, its database, credentials). SCRATCHBOX_HOME overrides it (tests point it at a temp dir); else ~/.scratchbox.
 */
export function scratchboxHome(): string {
    const configured = process.env.SCRATCHBOX_HOME?.trim();
    return configured ? path.resolve(configured) : path.join(os.homedir(), '.scratchbox');
}
