/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Builds the native engines a location request needs once the server is listening, so the first request normally finds
 * them ready instead of waiting for clang (and, for the Python module, CMake) before its first stage.
 *
 * The order is the request's critical path: tile_vegetation, tile_refine, scan_fit, then the scratchbox_native Python
 * module (the object builder's). Each step runs after the previous one, so the machine is never asked for two cold
 * builds at once, and logs its time. A step that fails is logged and the next step still runs; nothing is thrown.
 *
 * It is called after the API server's listen callback in the standalone server and in the Electron main process, and
 * never from createStandaloneServer, so a test that builds the app starts no compiler. SCRATCHBOX_NATIVE_WARMUP=0
 * turns it off (the isolated self-test instance).
 *
 * Nothing here claims a priority. A request that needs a binary that is still being built waits on the same build (the
 * services share one in-flight promise and one cross-process lock) and reports the wait.
 */

import { findTileRefineRepoRoot, getTileRefineService } from './tile-refine-service';
import { getTileVegetationService } from './tile-vegetation-service';
import { NativePythonRunnerService } from './native-python-runner-service';
import { loadScanFit } from './scan-fit-loader';

export interface WarmupStep {
    name: string;
    /** Resolves when the engine is ready; a string result is a note for the log ("not part of this build"). */
    run(): Promise<string | void>;
}

export interface WarmupStepReport {
    name: string;
    ok: boolean;
    ms: number;
    note?: string;
    error?: string;
}

export interface WarmupReport {
    skipped?: string;
    steps: WarmupStepReport[];
}

export interface WarmupOptions {
    log?: (message: string) => void;
    /** Replaces the real steps (tests). */
    steps?: WarmupStep[];
    now?: () => number;
    /** The environment to read SCRATCHBOX_NATIVE_WARMUP from. */
    env?: NodeJS.ProcessEnv;
}

/** The request path's engines, in order. */
export function nativeWarmupSteps(workspaceRoot: string): WarmupStep[] {
    return [
        { name: 'tile_vegetation', run: async () => { await getTileVegetationService(workspaceRoot).ensureBinary(); } },
        { name: 'tile_refine', run: async () => { await getTileRefineService(workspaceRoot).ensureBinary(); } },
        {
            name: 'scan_fit',
            run: async () => {
                const { service, unavailable } = await loadScanFit(workspaceRoot);
                if (!service) return unavailable;
                if (!service.ensureBinary) return 'the scan fitter has no binary to build';
                await service.ensureBinary();
            }
        },
        {
            name: 'scratchbox_native (Python module)',
            run: async () => {
                const error = await NativePythonRunnerService.getInstance().ensureNativeModule();
                if (error) throw new Error(error);
            }
        }
    ];
}

/**
 * Builds the engines in order. Resolves with what each step did; it never rejects. It is meant to be started without
 * awaiting it (`void warmNativeEngine(root)`).
 */
export async function warmNativeEngine(workspaceRoot: string = findTileRefineRepoRoot(), options: WarmupOptions = {}): Promise<WarmupReport> {
    const log = options.log ?? ((m: string) => console.log(m));
    const now = options.now ?? Date.now;
    const env = options.env ?? process.env;
    if (env.SCRATCHBOX_NATIVE_WARMUP === '0') {
        log('[native warm-up] off (SCRATCHBOX_NATIVE_WARMUP=0)');
        return { skipped: 'SCRATCHBOX_NATIVE_WARMUP=0', steps: [] };
    }
    const steps = options.steps ?? nativeWarmupSteps(workspaceRoot);
    const reports: WarmupStepReport[] = [];
    for (const step of steps) {
        const started = now();
        try {
            const note = await step.run();
            const ms = now() - started;
            reports.push({ name: step.name, ok: true, ms, ...(typeof note === 'string' && note ? { note } : {}) });
            log(`[native warm-up] ${step.name}: ${typeof note === 'string' && note ? note : 'ready'} (${(ms / 1000).toFixed(1)} s)`);
        } catch (err) {
            const ms = now() - started;
            const error = err instanceof Error ? err.message : String(err);
            reports.push({ name: step.name, ok: false, ms, error });
            log(`[native warm-up] ${step.name} failed after ${(ms / 1000).toFixed(1)} s: ${error.slice(0, 400)}`);
        }
    }
    return { steps: reports };
}
