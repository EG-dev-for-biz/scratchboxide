/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which of pipeline K's stages run their native kernels (the C++ ports beside this file, each bit for bit the
 * TypeScript's result, held to it by its parity test). Off by default: `SCRATCHBOX_K_NATIVE=1` (or `all`) turns every
 * port on, a comma list names some (`rectify`, `roof-shadow`, `regions`, `harmonize`), `0` or unset none. Read at each
 * call, so a worker thread sees the same environment as the server. A native build or run that fails is thrown, never
 * answered by the TypeScript path: the switch picks the engine, it is not a fallback.
 *
 * The outputs are the same either way, so the stages' versions (and the caches they name) do not change with it.
 */

export const K_NATIVE_STAGES = ['rectify', 'roof-shadow', 'regions', 'harmonize'] as const;
export type KNativeStage = (typeof K_NATIVE_STAGES)[number];

/** Whether `stage` runs its native kernel under `env` (default the process's). */
export function kNative(stage: KNativeStage, env: NodeJS.ProcessEnv = process.env): boolean {
    const v = (env.SCRATCHBOX_K_NATIVE ?? '').trim().toLowerCase();
    if (!v || v === '0' || v === 'off') return false;
    if (v === '1' || v === 'all' || v === 'on') return true;
    return v.split(',').map(s => s.trim()).includes(stage);
}
