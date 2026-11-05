/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * object_blueprint_outlines: the blueprint of a real object (blueprint-outlines.ts). Given the object and its overall
 * size, it draws orthographic side, top and front views, reads their silhouettes into outlines in metres in the
 * object build frame, and saves the views, the overlays and the outlines (blueprint.json). Given a built GLB and an
 * earlier blueprint instead, it reads the build's own outlines and lists where they differ, with no model call.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import {
    compareOutlines,
    describeDifferences,
    drawBlueprintViews,
    outlinesAsNotes,
    outlinesFromSilhouettes,
    outlinesFromTriangles,
    overlayOf,
    ASPECT_WARNING,
    axleWarp,
    warpZ,
    type ObjectOutlines,
    type Vec3
} from '../../3d-engine/blueprint-outlines';
import type { GenerateContentClient } from '../../3d-engine/reference-object-builder';
import { glbToTriangleSoupAsync } from '../../3d-engine/part-connectivity';
import { decodeImageToRgba } from '../../image-codec-ffmpeg';
import { encodePngAsync } from '../../png-codec-pool';
import { GeminiClient, errorMessage } from '../gemini-client';
import { findOpenings, type BlueprintOpening, type NormBox } from '../../3d-engine/blueprint-openings';
import { ObjectSegmenterService } from '../../video/ObjectSegmenterService';
import { PanoramaDepthService } from '../../spatial/PanoramaDepthService';
import { reliefGrid, RELIEF_GRID } from '../../3d-engine/blueprint-depth';

/** The app's depth model on a drawing: relative planar depth at the drawing's size. */
async function defaultDepth(imagePath: string, outDir: string): Promise<{ depths: Float32Array; width: number; height: number; model: string }> {
    const d = await new PanoramaDepthService().generateImageDepth(imagePath, { outDir });
    return { depths: d.depths, width: d.width, height: d.height, model: d.modelUsed };
}

/** The object segmenter's extent of the region in a box (normalised); fails on an empty mask. */
async function defaultSegment(imagePath: string, box: NormBox, outputDir: string, signal?: AbortSignal): Promise<NormBox> {
    const out = await new ObjectSegmenterService().segment({ imagePath, outputDir, box, refine: true, signal });
    const frame = out.frames[0];
    if (!frame || !(frame.areaFraction > 0)) throw new Error('the segmenter found nothing in the box');
    return frame.bbox;
}

export const BLUEPRINT_OUTLINE_TOOL = 'object_blueprint_outlines';

export const BLUEPRINT_OUTLINE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: BLUEPRINT_OUTLINE_TOOL,
        description: 'The blueprint of a real object whose overall size is known (a manufactured car, an aircraft, a piece of furniture): draws orthographic side, top and front views of it with an image model (three billed image calls), cuts out each silhouette and scales it to the given size, and returns its outlines in metres in the object build frame (+Z its front, +Y up from the ground, origin at the middle of its length and width): the side top and bottom line and the plan half width at stations along its length, the front half width at stations up its height, and where it touches the ground. ' +
            'It also returns them as notesText to paste into build_3d_object_from_reference\'s buildNotes, so the build is shaped to the outlines rather than to one picture. The views are generated drawings, so the outlines are labelled generated; aspectError per view says how far a drawing\'s proportions were off before it was scaled, and a published dimension the outlines contradict (such as a wheelbase against the ground contacts) means the drawing is wrong. ' +
            'To check a build against its blueprint, call it again with blueprintPath (the earlier result\'s) and compareGlbPath (the built model, e.g. "/models/scene_....glb"): no image is drawn, the build\'s outlines are read from its triangles and every span where it differs from the blueprint is listed, to fix in the spec and rebuild with specJson.',
        parameters: {
            type: 'OBJECT',
            properties: {
                subject: {
                    type: 'STRING',
                    description: 'For a new blueprint: what the object is, visually and exactly (year, make, model, generation, body style, trim, colour). No measurements.'
                },
                sizeMeters: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'For a new blueprint: the overall [width, height, length] in metres, everything included (a car\'s mirrors), as published; the same numbers as build_3d_object_from_reference\'s dimensionsHintMeters.'
                },
                blueprintPath: {
                    type: 'STRING',
                    description: 'To compare: the blueprintPath an earlier call returned.'
                },
                compareGlbPath: {
                    type: 'STRING',
                    description: 'To compare: the built model, as its scene path ("/models/<file>.glb") or a workspace path.'
                },
                model: {
                    type: 'STRING',
                    description: 'Optional image model for the views; omitted, the standard image model, then Nano Banana Lite.'
                },
                depth: {
                    type: 'BOOLEAN',
                    description: 'Optional, for a new blueprint: also read where the front and side drawings sink inside the outline (intakes, a recessed grille, glass behind its frame) with the app\'s depth model (Depth Anything V2 Small, local, not billed), as relief grids saved with the outlines (photo-inferred). A part lofted from the blueprint takes them with fromBlueprint.reliefMeters.'
                },
                axleZMeters: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional, for a new blueprint of an object on wheels or legs: where its two outermost ground contacts belong along the length, [front, rear] z in metres in the build frame (a car\'s published axles: front z = length/2 - front overhang, rear z = front z - wheelbase). The side and plan drawings are then stretched along the length so their drawn contacts land there, the ends staying at the ends (labelled generated). Refused, with the reason, when the drawn contacts are more than 12 % off that spacing: that drawing is wrong, not merely out of scale.'
                },
                openings: {
                    type: 'BOOLEAN',
                    description: 'Optional, for a new blueprint: also read the areas set into the surface (openings, recessed panels, grilles, vents, glass behind frames) from the front and side drawings, each boxed by a vision model (one more billed call) and traced by the object segmenter, as extents in metres in the build frame (labelled generated): the places to cut or set glass.'
                }
            }
        }
    }
];

export interface BlueprintOutlineToolDeps {
    client?: () => Promise<GenerateContentClient | undefined>;
    /** Traces a region inside a box of a drawing (normalised); the object segmenter by default. */
    segment?: (imagePath: string, box: NormBox, outputDir: string, signal?: AbortSignal) => Promise<NormBox>;
    /** Relative depth of a drawing (row-major, its own size); the app's depth model by default. */
    depth?: (imagePath: string, outDir: string) => Promise<{ depths: Float32Array; width: number; height: number; model: string }>;
    /** Where public/models lives (scene paths "/models/..." resolve there); default the repository's. */
    publicDir?: string;
    sleep?: (ms: number) => Promise<void>;
}

function repoRoot(): string {
    return process.env.SCRATCHBOX_ROOT || (fs.existsSync(path.resolve(process.cwd(), 'packages')) ? process.cwd() : path.resolve(process.cwd(), '..'));
}

function failed(message: string): ToolHandlerOutcome {
    return { status: 'failed', summaryResult: `Failed: ${message}`, resultPayload: { status: 'failed', success: false, error: message } };
}

function parseSize(v: unknown): Vec3 | undefined | 'invalid' {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) return 'invalid';
    return v as Vec3;
}

/** A model path the chat gives: a scene path under public/, else a path inside the workspace or the repository. */
function resolveModelPath(given: string, workspaceRoot: string, publicDir: string): string | undefined {
    const roots = [path.resolve(workspaceRoot), path.resolve(repoRoot())];
    const candidates = given.startsWith('/models/')
        ? [path.join(publicDir, given)]
        : path.isAbsolute(given) ? [given] : roots.map(r => path.resolve(r, given));
    return candidates.find(c => (roots.some(r => c.startsWith(r + path.sep)) || c.startsWith(path.resolve(publicDir) + path.sep)) && fs.existsSync(c));
}

export function createBlueprintOutlineHandlers(deps: BlueprintOutlineToolDeps = {}): Record<string, ToolHandler> {
    return {
        [BLUEPRINT_OUTLINE_TOOL]: async (args, ctx): Promise<ToolHandlerOutcome> => {
            const publicDir = deps.publicDir ?? path.join(repoRoot(), 'public');
            const blueprintPath = typeof args.blueprintPath === 'string' && args.blueprintPath.trim() ? args.blueprintPath.trim() : undefined;
            const compareGlbPath = typeof args.compareGlbPath === 'string' && args.compareGlbPath.trim() ? args.compareGlbPath.trim() : undefined;

            if (blueprintPath || compareGlbPath) {
                if (!blueprintPath || !compareGlbPath) return failed('To compare a build with its blueprint, pass both blueprintPath and compareGlbPath.');
                const bpFile = resolveModelPath(blueprintPath, ctx.workspaceRoot, publicDir);
                if (!bpFile) return failed(`No blueprint at ${blueprintPath}.`);
                const glbFile = resolveModelPath(compareGlbPath, ctx.workspaceRoot, publicDir);
                if (!glbFile) return failed(`No model at ${compareGlbPath}.`);
                let blueprint: ObjectOutlines;
                try {
                    blueprint = JSON.parse(fs.readFileSync(bpFile, 'utf8')).outlines;
                } catch (err) {
                    return failed(`${blueprintPath} is not a blueprint: ${errorMessage(err)}`);
                }
                const soup = await glbToTriangleSoupAsync(fs.readFileSync(glbFile), { colors: false, signal: ctx.signal });
                if (!soup) return failed(`${compareGlbPath} is not a GLB.`);
                const built = outlinesFromTriangles(soup, blueprint);
                const comparison = compareOutlines(blueprint, built);
                const lines = describeDifferences(comparison);
                return {
                    resultPayload: { status: 'success', blueprintPath, compareGlbPath, builtSizeMeters: built.sizeMeters, blueprintSizeMeters: blueprint.sizeMeters, builtGroundContacts: built.groundContacts, blueprintGroundContacts: blueprint.groundContacts, comparison, differences: lines },
                    summaryResult: lines.length
                        ? `The build differs from its blueprint (tolerance ${comparison.toleranceMeters} m) in ${comparison.differences.length} span(s):\n${lines.map(l => `- ${l}`).join('\n')}`
                        : `The build matches its blueprint within ${comparison.toleranceMeters} m at every station.`
                };
            }

            const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
            if (!subject) return failed('object_blueprint_outlines needs subject and sizeMeters for a new blueprint, or blueprintPath and compareGlbPath to compare a build.');
            const size = parseSize(args.sizeMeters);
            if (!size || size === 'invalid') return failed('sizeMeters must be three positive numbers [width, height, length] in metres.');
            const client = await (deps.client ?? (() => new GeminiClient().getGenAIClient()))();
            if (!client) return failed('No Google API key or service account configured, so no blueprint can be drawn.');

            let views;
            try {
                views = await drawBlueprintViews(client, {
                    subject, sizeMeters: size,
                    model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined,
                    signal: ctx.signal, reportProgress: ctx.reportProgress,
                    decode: data => decodeImageToRgba(data),
                    sleep: deps.sleep
                });
            } catch (err) {
                return failed(`The blueprint could not be drawn: ${errorMessage(err)}`);
            }
            const byView = Object.fromEntries(views.map(v => [v.view, v.silhouette])) as Parameters<typeof outlinesFromSilhouettes>[0];
            let outlines = outlinesFromSilhouettes(byView, size);
            const axles = args.axleZMeters;
            if (axles !== undefined && !(Array.isArray(axles) && axles.length === 2 && axles.every(n => typeof n === 'number' && Number.isFinite(n)) && axles[0] !== axles[1])) {
                return failed('axleZMeters must be two different numbers [front, rear] z in metres.');
            }
            let warpNote: string | undefined;
            let drawnContacts: ObjectOutlines['groundContacts'] | undefined;
            if (axles) {
                const fit = axleWarp(outlines, axles as [number, number]);
                if ('warp' in fit) {
                    drawnContacts = outlines.groundContacts;
                    outlines = outlinesFromSilhouettes(byView, size, fit.warp);
                } else {
                    warpNote = `Not stretched to the axles: ${fit.reason}.`;
                }
            }

            const dir = path.join(ctx.workspaceRoot || process.cwd(), 'output', 'blueprints', `${Date.now()}`);
            fs.mkdirSync(dir, { recursive: true });
            const files: Record<string, string> = {};
            for (const v of views) {
                const ext = v.image.mimeType.includes('jpeg') ? 'jpg' : 'png';
                files[v.view] = path.join(dir, `${v.view}.${ext}`);
                fs.writeFileSync(files[v.view], v.image.data);
                const overlay = overlayOf(await decodeImageToRgba(v.image.data), v.silhouette);
                files[`${v.view}Overlay`] = path.join(dir, `${v.view}_outline.png`);
                fs.writeFileSync(files[`${v.view}Overlay`], await encodePngAsync(overlay.width, overlay.height, overlay.rgba, 4));
            }
            let openings: BlueprintOpening[] | undefined;
            let openingsNote: string | undefined;
            if (args.openings === true) {
                ctx.reportProgress?.('Reading the openings from the front and side drawings', 0.8);
                const view = (name: 'front' | 'side') => { const v = views.find(x => x.view === name)!; return { image: v.image, path: files[name], silhouette: v.silhouette }; };
                let n = 0;
                const segment = deps.segment ?? defaultSegment;
                try {
                    const knots = outlines.lengthWarp?.knots;
                    const read = await findOpenings(client, subject, { front: view('front'), side: view('side') }, size, {
                        segment: (imagePath, box) => segment(imagePath, box, path.join(dir, 'masks', String(n++)), ctx.signal),
                        ...(knots ? { fromDrawnZ: (z: number) => Math.round(warpZ(knots, z, 'drawnZ', 'z') * 1000) / 1000 } : {}),
                        signal: ctx.signal
                    });
                    openings = read.openings;
                } catch (err) {
                    openingsNote = `The openings could not be read: ${errorMessage(err)}`;
                }
            }
            let depthNote: string | undefined;
            if (args.depth === true) {
                ctx.reportProgress?.('Reading where the front and side drawings sink, with the depth model', 0.85);
                const depthOf = deps.depth ?? defaultDepth;
                try {
                    const relief: NonNullable<ObjectOutlines['relief']> = {};
                    for (const name of ['front', 'side'] as const) {
                        const v = views.find(x => x.view === name)!;
                        const d = await depthOf(files[name], path.join(dir, 'depth'));
                        if (d.width !== v.silhouette.width || d.height !== v.silhouette.height) throw new Error(`the depth map is ${d.width} x ${d.height} for a ${v.silhouette.width} x ${v.silhouette.height} drawing`);
                        const [cols, rows] = RELIEF_GRID[name];
                        relief[name] = reliefGrid(d.depths, v.silhouette, cols, rows);
                        relief.model = d.model;
                    }
                    outlines.relief = relief;
                } catch (err) {
                    depthNote = `The relief could not be read: ${errorMessage(err)}`;
                }
            }
            const aspectError = Object.fromEntries(views.map(v => [v.view, v.aspectError]));
            const provenance = { label: 'generated', note: `Outlines read from orthographic views drawn by ${[...new Set(views.map(v => v.model))].join(', ')} and scaled to the given size; not measured.` };
            const blueprintFile = path.join(dir, 'blueprint.json');
            fs.writeFileSync(blueprintFile, JSON.stringify({ subject, sizeMeters: size, outlines, aspectError, provenance, models: views.map(v => ({ view: v.view, model: v.model })), ...(openings ? { openings } : {}) }, null, 1));
            const rel = (f: string) => path.relative(ctx.workspaceRoot || process.cwd(), f);
            const offScale = views.filter(v => Math.abs(v.aspectError) > ASPECT_WARNING);
            const notesText = outlinesAsNotes(outlines);
            return {
                resultPayload: {
                    status: 'success', subject, sizeMeters: size, blueprintPath: rel(blueprintFile),
                    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, rel(f)])),
                    aspectError, outlines, notesText, provenance,
                    ...(openings ? { openings } : {}), ...(openingsNote ? { openingsNote } : {}),
                    ...(depthNote ? { depthNote } : {}),
                    ...(drawnContacts ? { drawnGroundContacts: drawnContacts } : {}), ...(warpNote ? { warpNote } : {})
                },
                summaryResult: [
                    `Drew the side, top and front views of ${subject} and read their outlines at ${size.join(' x ')} m (blueprint ${rel(blueprintFile)}).`,
                    `Drawn proportions before scaling: side ${aspectError.side}, top ${aspectError.top}, front ${aspectError.front}.`,
                    outlines.lengthWarp ? `Stretched along the length to the axles: ${outlines.lengthWarp.note}.` : (warpNote ?? ''),
                    offScale.length ? `Not to scale: ${offScale.map(v => `${v.view} (${(v.aspectError * 100).toFixed(0)} %)`).join(', ')}; its outline is stretched to the size, so read it with care.` : '',
                    outlines.relief ? `Read where the front and side drawings sink with ${outlines.relief.model} (photo-inferred relief, saved with the outlines; lofted parts take it with reliefMeters).` : (depthNote ?? ''),
                    openings ? `Read ${openings.length} opening${openings.length === 1 ? '' : 's'} (${openings.filter(o => o.traced).length} traced by the segmenter): ${openings.slice(0, 12).map(o => `${o.label} (${o.view}, ${o.view === 'front' ? 'x' : 'z'} ${o.across[0]}..${o.across[1]}, y ${o.height[0]}..${o.height[1]})`).join('; ')}.` : (openingsNote ?? ''),
                    outlines.groundContacts.length
                        ? `Touches the ground at z ${outlines.groundContacts.map(c => c.zCentre).join(', ')} m${outlines.groundContacts.length > 1 ? `, the outermost contacts ${(outlines.groundContacts[0].zCentre - outlines.groundContacts[outlines.groundContacts.length - 1].zCentre).toFixed(3)} m apart (check it against a published spacing, such as a wheelbase)` : ''}.`
                        : 'No ground contact was read from the side view.'
                ].filter(Boolean).join(' ')
            };
        }
    };
}

export const blueprintOutlineHandlers = createBlueprintOutlineHandlers();
