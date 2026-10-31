/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';

/**
 * Removes a headless Chrome's temporary profile after the browser was killed. Chrome's helper processes (GPU,
 * crashpad) can outlive it and keep writing into the profile for a moment, so on a busy machine the folder may not
 * empty in time (ENOTEMPTY). Such a profile is left in the OS temp folder with a warning, never failing the test
 * that used the browser: what the test checked was decided before this cleanup.
 */
export function removeChromeProfile(profile: string): void {
    try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (err) {
        console.warn(`[chrome] left its temporary profile ${profile}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
