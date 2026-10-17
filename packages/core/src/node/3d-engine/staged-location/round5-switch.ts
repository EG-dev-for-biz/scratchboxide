/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measurement switch for the round-5 registration and view-selection changes (docs/processes/staged_location_texture_pass_live_arch.md).
 * With SCRATCHBOX_STAGED_ROUND4_BASELINE=1 the pass runs as round 4 did (per-pano pose choice, round-4 view selection, photos
 * projected on every fitted texel), so the held-out fit of the same run can be compared before and after on the same measure.
 * Off by default; read at call time so a test can set it.
 */
export function round4Baseline(): boolean {
    return process.env.SCRATCHBOX_STAGED_ROUND4_BASELINE === '1';
}

/** The joint pano registration runs (pano-joint-registration.ts). */
export function jointRegistrationEnabled(): boolean {
    return !round4Baseline();
}
