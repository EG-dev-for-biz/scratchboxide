/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Measurement switches for the round-5 registration and texture changes (docs/processes/staged_location_texture_pass_live_arch.md),
 * so the held-out fit of the same inputs can be compared with and without each. All on by default; read at call time.
 *  - SCRATCHBOX_STAGED_ROUND4_BASELINE=1 turns all of them off (the pass as round 4 ran it);
 *  - SCRATCHBOX_STAGED_ROUND5_OFF=joint,viewSelection,offScan turns off the ones listed.
 */
export type Round5Feature = 'joint' | 'viewSelection' | 'offScan';

export function round4Baseline(): boolean {
    return process.env.SCRATCHBOX_STAGED_ROUND4_BASELINE === '1';
}

export function round5Enabled(feature: Round5Feature): boolean {
    if (round4Baseline()) return false;
    return !(process.env.SCRATCHBOX_STAGED_ROUND5_OFF ?? '').split(',').map(s => s.trim()).includes(feature);
}

/** The joint pano registration runs (pano-joint-registration.ts). */
export function jointRegistrationEnabled(): boolean {
    return round5Enabled('joint');
}
