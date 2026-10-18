/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Typed failures for generation pipelines. A step either does what was asked or throws one of these;
 * it never substitutes other output. Tool handlers let them propagate, and ToolRegistry reports the
 * call as `failed` with the message, so the model tells the user what went wrong.
 *
 * `code` is a stable string for callers that only see serialized results.
 */
export abstract class PipelineError extends Error {
    abstract readonly code: string;
}

function messageOf(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

/** A place name or coordinate could not be resolved to one real location. */
export class LocationUnresolvedError extends PipelineError {
    readonly code = 'location_unresolved';

    constructor(readonly query: string, readonly reason: string) {
        super(`Could not resolve location "${query}": ${reason}`);
        this.name = 'LocationUnresolvedError';
    }
}

/** Pipeline stage names are diagnostic labels; nothing branches on them. */
export type TileExtractionStage = 'crawl' | 'download' | 'parse' | 'remesh' | 'vegetation' | (string & {});

/** Photorealistic 3D Tiles extraction (or a step that processes its output) failed at `stage`. */
export class TileExtractionError extends PipelineError {
    readonly code = 'tile_extraction_failed';

    constructor(readonly stage: TileExtractionStage, cause: unknown) {
        super(`Tile extraction failed at ${stage}: ${messageOf(cause)}`, cause instanceof Error ? { cause } : undefined);
        this.name = 'TileExtractionError';
    }
}

/** An image or video model did not produce output (not served, rejected the request, or returned nothing). */
export class MediaModelUnavailableError extends PipelineError {
    readonly code = 'media_model_unavailable';

    constructor(readonly model: string, readonly reason: string) {
        super(`Media model ${model} is unavailable: ${reason}`);
        this.name = 'MediaModelUnavailableError';
    }
}

/** A vision model could not inspect the input. `status` is the HTTP status or a short failure label. */
export class VisionUnavailableError extends PipelineError {
    readonly code = 'vision_unavailable';

    constructor(readonly model: string, readonly status: number | string, detail?: string) {
        super(`Vision model ${model} is unavailable (${status})${detail ? `: ${detail}` : ''}`);
        this.name = 'VisionUnavailableError';
    }
}

/** A native or scripted generator (python, cpp, ...) failed. `stderr` carries the generator's own output. */
export class GeneratorFailedError extends PipelineError {
    readonly code = 'generator_failed';

    constructor(readonly engine: 'python' | 'cpp' | (string & {}), readonly stderr: string) {
        super(`The ${engine} generator failed: ${stderr.trim().slice(0, 2000) || 'no output'}`);
        this.name = 'GeneratorFailedError';
    }
}

/** A required input was not supplied. The tool does not pick a benchmark, preset or default instead. */
export class MissingInputError extends PipelineError {
    readonly code = 'missing_input';

    constructor(readonly tool: string, readonly arg: string, detail?: string) {
        super(`${tool} needs ${arg}${detail ? `: ${detail}` : ''}`);
        this.name = 'MissingInputError';
    }
}

/** A supplied input is not one the tool can use (e.g. a preset name it does not define). The tool does not substitute another. */
export class InvalidInputError extends PipelineError {
    readonly code = 'invalid_input';

    constructor(readonly tool: string, readonly arg: string, detail?: string) {
        super(`${tool}: ${arg} is not usable${detail ? `: ${detail}` : ''}`);
        this.name = 'InvalidInputError';
    }
}

/**
 * The object a segmentation was asked for is not in the image (the vision model said so, or none of the prompts gave a
 * mask). Nothing else is cut out in its place.
 */
export class SegmentTargetNotFoundError extends PipelineError {
    readonly code = 'segment_target_not_found';

    constructor(readonly tool: string, readonly target: string, readonly reason: string, readonly frame?: number) {
        super(`${tool}: ${target} was not found${frame !== undefined ? ` in frame ${frame}` : ''}: ${reason}`);
        this.name = 'SegmentTargetNotFoundError';
    }
}
