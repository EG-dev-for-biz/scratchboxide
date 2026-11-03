/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which of pipeline K's stages run their native kernels (the C++ ports beside this file and the remesh polish's,
 * remesh-polish-native.ts; each bit for bit the TypeScript's result, held to it by its parity test). On by default:
 * unset, `1`, `all` or `on` runs every port; `SCRATCHBOX_K_NATIVE=0` (or `off`) runs the TypeScript everywhere; a comma
 * list names the ports that run (`rectify`, `window-fit`, `wall-grammar`, `wall-sheets`, `lattice`, `cut`, `stitch`, `clip`, `infill`, `fill-texture`, `roof-shadow`, `regions`, `harmonize`), the rest in
 * TypeScript. Read at each call, so a worker thread sees the same environment as the server. A native build or run that
 * fails is thrown, never answered by the TypeScript path: the switch picks the engine, it is not a fallback.
 *
 * The outputs are the same either way, so the stages' versions (and the caches they name) do not change with it.
 *
 * Retired (2026-11-03; the ports' own switches while they were reviewed apart): a SCRATCHBOX_K_NATIVE_POLISH
 * (the window fit and the infill), SCRATCHBOX_K_NATIVE_TWIN, SCRATCHBOX_K_NATIVE_TWIN_THREADS or
 * SCRATCHBOX_K_NATIVE_TWIN_BIN still set is not read, and is reported once with its replacement.
 */

export const K_NATIVE_STAGES = ['rectify', 'window-fit', 'wall-grammar', 'wall-sheets', 'lattice', 'cut', 'stitch', 'clip', 'infill', 'fill-texture', 'roof-shadow', 'regions', 'harmonize'] as const;
export type KNativeStage = (typeof K_NATIVE_STAGES)[number];

/** The retired switches and what to set instead. */
export const RETIRED_K_NATIVE_SWITCHES: Readonly<Record<string, string>> = {
    SCRATCHBOX_K_NATIVE_POLISH: 'SCRATCHBOX_K_NATIVE (0: every port in TypeScript; or a list without window-fit and infill)',
    SCRATCHBOX_K_NATIVE_TWIN: 'SCRATCHBOX_K_NATIVE (0: every port in TypeScript; or a list without roof-shadow and harmonize)',
    SCRATCHBOX_K_NATIVE_TWIN_THREADS: 'SCRATCHBOX_K_NATIVE_THREADS',
    SCRATCHBOX_K_NATIVE_TWIN_BIN: 'SCRATCHBOX_TWIN_TEXELS_BIN'
};

/** One sentence per retired switch still set in `env`. */
export function kNativeSwitchProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    return Object.entries(RETIRED_K_NATIVE_SWITCHES).filter(([name]) => env[name] !== undefined).map(([name, use]) => `${name} is retired and not read; set ${use}.`);
}

let reported = false;

/** Whether `stage` runs its native kernel under `env` (default the process's). */
export function kNative(stage: KNativeStage, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!reported) {
        reported = true;
        for (const problem of kNativeSwitchProblems(env)) console.warn(`[pipeline-k] ${problem}`);
    }
    const v = (env.SCRATCHBOX_K_NATIVE ?? '').trim().toLowerCase();
    if (!v || v === '1' || v === 'all' || v === 'on') return true;
    if (v === '0' || v === 'off') return false;
    return v.split(',').map(s => s.trim()).includes(stage);
}
