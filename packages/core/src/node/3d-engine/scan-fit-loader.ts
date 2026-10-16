/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Finds the scan fitter (scan-fit-service.ts, the native engine's TypeScript face) when this build has it.
 *
 * The fitter and the staged-build orchestrator are separate pieces of one feature. The orchestrator needs only the
 * four calls of StagedLocationDeps.scanFit, so it does not import the service: it asks here. Without the service the
 * answer is "unavailable" with the reason, and the orchestrator's rebuild stages degrade and say so (the remeshed scan
 * stays the structure). Nothing is faked in its place.
 */

import type { ScanFitDeps } from './staged-location/orchestrator';

/** What the loader needs of the service module: a getter per workspace (like getTileVegetationService), or the class. */
interface ScanFitModule {
    getScanFitService?: (workspaceRoot: string) => ScanFitDeps & { ensureBinary?: () => Promise<unknown> };
    ScanFitService?: new (options: { workspaceRoot: string }) => ScanFitDeps & { ensureBinary?: () => Promise<unknown> };
}

export type ScanFitService = ScanFitDeps & { ensureBinary?: () => Promise<unknown> };

export interface ScanFitLoad {
    service?: ScanFitService;
    /** Why there is none (shown to the user). */
    unavailable?: string;
}

const MODULE_SPECIFIER = './scan-fit-service';

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** The module's code is "not found" for the specifier itself, not for something it imports. */
function isMissingModule(err: unknown, specifier: string): boolean {
    const code = (err as { code?: string })?.code;
    const text = messageOf(err);
    return (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to (resolve|load) (import|url)|Cannot find package/i.test(text))
        && text.includes(specifier.replace(/^\.\//, ''));
}

const loaded = new Map<string, ScanFitLoad>();

/**
 * One scan fitter per workspace root. `specifier` is for tests (a module that exports getScanFitService or ScanFitService).
 */
export async function loadScanFit(workspaceRoot: string, specifier: string = MODULE_SPECIFIER): Promise<ScanFitLoad> {
    const cacheKey = `${specifier}|${workspaceRoot}`;
    const known = loaded.get(cacheKey);
    if (known?.service) return known;
    let result: ScanFitLoad;
    try {
        const mod = (await import(/* @vite-ignore */ specifier)) as ScanFitModule;
        if (typeof mod.getScanFitService === 'function') result = { service: mod.getScanFitService(workspaceRoot) };
        else if (typeof mod.ScanFitService === 'function') result = { service: new mod.ScanFitService({ workspaceRoot }) };
        else result = { unavailable: 'the scan fitter module does not export getScanFitService or ScanFitService' };
    } catch (err) {
        result = {
            unavailable: isMissingModule(err, specifier)
                ? 'the scan fitter (scan-fit-service) is not part of this build of the app'
                : `the scan fitter could not be loaded: ${messageOf(err)}`
        };
    }
    if (result.service) loaded.set(cacheKey, result);
    return result;
}
