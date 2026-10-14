/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The scene's own generator could not produce its model; the viewport shows this instead of any other geometry. */
export interface GeneratorRunError {
    engine: 'python' | 'cpp';
    message: string;
}

const ENGINE_LABEL: Record<GeneratorRunError['engine'], string> = {
    python: 'The Python generator',
    cpp: 'The C++ generator'
};

/** Keeps the end of long compiler / interpreter output, where the actual error is. */
function tail(text: string, max = 1200): string {
    const t = text.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * Reads a /3d/python/run or /3d/compile response. Returns null when it carries the model (GLB), otherwise the
 * error to show: the runner's stderr / compiler output when there is one, the server error, or the HTTP status.
 */
export function generatorRunFailure(engine: GeneratorRunError['engine'], httpStatus: number, body: any): GeneratorRunError | null {
    if (body?.success && typeof body.glbBase64 === 'string' && body.glbBase64.length > 0) return null;
    const label = ENGINE_LABEL[engine];
    if (body?.success) {
        return { engine, message: `${label} ran but wrote no model (GLB).` };
    }
    const detail = [body?.errorDetails, body?.stderr, body?.compilerOutput, body?.error]
        .find(v => typeof v === 'string' && v.trim().length > 0) as string | undefined;
    return { engine, message: `${label} failed: ${detail ? tail(detail) : `HTTP ${httpStatus}`}` };
}

/** A request that never got a readable answer (network error, non-JSON body). */
export function generatorRequestFailure(engine: GeneratorRunError['engine'], err: unknown): GeneratorRunError {
    const message = err instanceof Error ? err.message : String(err);
    return { engine, message: `${ENGINE_LABEL[engine]} could not be run: ${message}` };
}
