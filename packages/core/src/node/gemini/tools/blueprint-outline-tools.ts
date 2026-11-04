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
    type ObjectOutlines,
    type Vec3
} from '../../3d-engine/blueprint-outlines';
import type { GenerateContentClient } from '../../3d-engine/reference-object-builder';
import { glbToTriangleSoupAsync } from '../../3d-engine/part-connectivity';
import { decodeImageToRgba } from '../../image-codec-ffmpeg';
import { encodePngAsync } from '../../png-codec-pool';
import { GeminiClient, errorMessage } from '../gemini-client';

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
                }
            }
        }
    }
];

export interface BlueprintOutlineToolDeps {
    client?: () => Promise<GenerateContentClient | undefined>;
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
            const outlines = outlinesFromSilhouettes(byView, size);

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
            const aspectError = Object.fromEntries(views.map(v => [v.view, v.aspectError]));
            const provenance = { label: 'generated', note: `Outlines read from orthographic views drawn by ${[...new Set(views.map(v => v.model))].join(', ')} and scaled to the given size; not measured.` };
            const blueprintFile = path.join(dir, 'blueprint.json');
            fs.writeFileSync(blueprintFile, JSON.stringify({ subject, sizeMeters: size, outlines, aspectError, provenance, models: views.map(v => ({ view: v.view, model: v.model })) }, null, 1));
            const rel = (f: string) => path.relative(ctx.workspaceRoot || process.cwd(), f);
            const offScale = views.filter(v => Math.abs(v.aspectError) > ASPECT_WARNING);
            const notesText = outlinesAsNotes(outlines);
            return {
                resultPayload: {
                    status: 'success', subject, sizeMeters: size, blueprintPath: rel(blueprintFile),
                    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, rel(f)])),
                    aspectError, outlines, notesText, provenance
                },
                summaryResult: [
                    `Drew the side, top and front views of ${subject} and read their outlines at ${size.join(' x ')} m (blueprint ${rel(blueprintFile)}).`,
                    `Drawn proportions before scaling: side ${aspectError.side}, top ${aspectError.top}, front ${aspectError.front}.`,
                    offScale.length ? `Not to scale: ${offScale.map(v => `${v.view} (${(v.aspectError * 100).toFixed(0)} %)`).join(', ')}; its outline is stretched to the size, so read it with care.` : '',
                    outlines.groundContacts.length
                        ? `Touches the ground at z ${outlines.groundContacts.map(c => c.zCentre).join(', ')} m${outlines.groundContacts.length > 1 ? `, the outermost contacts ${(outlines.groundContacts[0].zCentre - outlines.groundContacts[outlines.groundContacts.length - 1].zCentre).toFixed(3)} m apart (check it against a published spacing, such as a wheelbase)` : ''}.`
                        : 'No ground contact was read from the side view.'
                ].filter(Boolean).join(' ')
            };
        }
    };
}

export const blueprintOutlineHandlers = createBlueprintOutlineHandlers();
