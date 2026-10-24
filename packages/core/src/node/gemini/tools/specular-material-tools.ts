/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * infer_specular_materials: reflective/dielectric material detection (by default, glass) on any single GLB, not only
 * the staged-location facades facade-materials.ts reads. Three evidentiary tiers, tried in this order as the caller's
 * input allows:
 *
 *  1. Posed real evidence (referenceViews: real photos, or pipeline I/J's own sheet-station cameras) — the strongest:
 *     labelled photo-inferred, the same floor facade-materials.ts holds Street View to (at least two independent
 *     views must mark a region before it is accepted).
 *  2. Self-render (the default: nothing but a GLB path needed) — a few canonical views rendered of the mesh's own
 *     existing bake (specular-canonical-views.ts), checked against each other the same way. Labelled generated: this
 *     is the mesh checking its own bake for consistency, not independent evidence.
 *  3. Single-view fallback (allowSingleViewFallback, only tried when 1/2 found nothing): the same self-render views
 *     without the two-views-agree floor. Lowest confidence, labelled generated, and the result says plainly that the
 *     floor was dropped.
 *
 * Accepted regions are, by default, baked into a new copy of the mesh (specular-material-bake.ts) as a real
 * metallicRoughness texture at the mesh's own UV layout; nothing outside them changes. A mesh with more than one
 * material cannot be baked (specular-material-bake.ts's own limit) and is reported as such, not silently dropped.
 */

import * as fs from 'fs';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import { decodePng } from '../../texture-processing';
import { FACADE_GLASS_TARGET, segmenterTool, type SegmentImage } from '../../3d-engine/staged-location/facade-material-evidence';
import { gatherSelfRenderEvidence, segmentPosedViews } from '../../spatial/specular-material-evidence';
import type { RenderedView } from '../../spatial/specular-canonical-views';
import { projectMaskedViewsToUv, type SpecularProjectionResult } from '../../spatial/specular-material-projection';
import { bakeSpecularMaterials } from '../../spatial/specular-material-bake';
import type { ToolDeclaration, ToolHandler } from './types';

export const SPECULAR_MATERIALS_TOOL_NAME = 'infer_specular_materials';

export const SPECULAR_MATERIALS_TOOL_DECLARATION: ToolDeclaration = {
    name: SPECULAR_MATERIALS_TOOL_NAME,
    description: 'Finds a described reflective or dielectric surface (by default, glass window panes) on any single textured GLB — a '
        + 'staged-location building, a procedural object, a Trellis/Meshy model (pipeline I/J), anything with its own bake — and writes it '
        + 'into a new copy of the mesh as a real metallicRoughness texture (low roughness, dielectric, so the viewer\'s own environment gives '
        + 'the reflection), leaving everything outside it unchanged. Evidence, strongest first: referenceViews (real photos or known-pose '
        + 'renders, e.g. pipeline I/J\'s own character-sheet stations) when given; otherwise a few canonical views rendered of the mesh\'s own '
        + 'bake (the default, needs nothing but the GLB). Either way a region is accepted only where at least minAgreeingViews independent '
        + 'views mark it (facade-materials.ts\'s own floor, generalized to any mesh); allowSingleViewFallback drops that floor, at lower '
        + 'confidence, only when the first pass found nothing. A mesh with more than one material is reported, not baked (needs splitting '
        + 'first). Every result names its tier and confidence; nothing here is ever labelled measured.',
    parameters: {
        type: 'OBJECT',
        properties: {
            glbPath: { type: 'STRING', description: 'The mesh to read (and, unless bake is false, to write a new textured copy of).' },
            target: { type: 'STRING', description: 'The surface to find, as a plain description (default "the glass window panes"). Pass another description for chrome trim, standing water, polished stone, etc.' },
            referenceViews: {
                type: 'ARRAY',
                description: 'Real photos or known-pose renders of the mesh, e.g. pipeline I/J\'s own character-sheet stations. Each needs a pinhole camera in the mesh\'s own coordinates and an image path. Omit to self-render instead (the default).',
                items: {
                    type: 'OBJECT',
                    properties: {
                        imagePath: { type: 'STRING', description: 'PNG of this view.' },
                        eye: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Camera position [x, y, z].' },
                        right: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Camera right axis, normalized [x, y, z].' },
                        up: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Camera up axis, normalized [x, y, z].' },
                        fwd: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Camera forward axis, normalized [x, y, z].' },
                        fx: { type: 'NUMBER', description: 'Focal length in pixels, horizontal.' },
                        fy: { type: 'NUMBER', description: 'Focal length in pixels, vertical.' },
                        cx: { type: 'NUMBER', description: 'Principal point x in pixels (usually width / 2).' },
                        cy: { type: 'NUMBER', description: 'Principal point y in pixels (usually height / 2).' }
                    },
                    required: ['imagePath', 'eye', 'right', 'up', 'fwd', 'fx', 'fy', 'cx', 'cy']
                }
            },
            selfRenderViews: { type: 'NUMBER', description: 'Canonical views to render when no referenceViews are given (default 6).' },
            minAgreeingViews: { type: 'NUMBER', description: 'Independent views that must agree before a region is accepted (default 2; the same floor facade-materials.ts holds Street View to).' },
            allowSingleViewFallback: { type: 'BOOLEAN', description: 'If the first pass accepts nothing, try again without the agreement floor (lowest confidence, stated as such). Default false.' },
            bake: { type: 'BOOLEAN', description: 'Write a new textured copy of the mesh with the accepted regions as a real metallicRoughness texture (default true). False just reports the regions.' },
            outputGlbPath: { type: 'STRING', description: 'Where to write the new copy (default glbPath with "_specular" before the extension).' }
        },
        required: ['glbPath']
    }
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function defaultOutputPath(glbPath: string): string {
    const dot = glbPath.lastIndexOf('.');
    return dot > 0 ? `${glbPath.slice(0, dot)}_specular${glbPath.slice(dot)}` : `${glbPath}_specular.glb`;
}

function regionConfidence(result: SpecularProjectionResult, tierScale: number): number {
    if (!result.regions.length) return 0;
    const weighted = result.regions.reduce((sum, r) => sum + r.confidence * r.cells, 0);
    const cells = result.regions.reduce((sum, r) => sum + r.cells, 0);
    return Math.min(0.9, (cells ? weighted / cells : 0) * tierScale);
}

async function readReferenceViews(args: unknown[]): Promise<RenderedView[]> {
    const views: RenderedView[] = [];
    for (const raw of args) {
        const v = raw as Record<string, unknown>;
        const imagePath = str(v.imagePath);
        if (!imagePath) throw new MissingInputError(SPECULAR_MATERIALS_TOOL_NAME, 'referenceViews[].imagePath', 'a PNG path for each reference view');
        if (!fs.existsSync(imagePath)) throw new MissingInputError(SPECULAR_MATERIALS_TOOL_NAME, 'an existing referenceViews[].imagePath', `got ${imagePath}`);
        const png = fs.readFileSync(imagePath);
        const decoded = decodePng(png);
        const tuple3 = (x: unknown, name: string): [number, number, number] => {
            if (!Array.isArray(x) || x.length !== 3) throw new MissingInputError(SPECULAR_MATERIALS_TOOL_NAME, `referenceViews[].${name}`, 'an [x, y, z] array');
            return [Number(x[0]), Number(x[1]), Number(x[2])];
        };
        views.push({
            eye: tuple3(v.eye, 'eye'), right: tuple3(v.right, 'right'), up: tuple3(v.up, 'up'), fwd: tuple3(v.fwd, 'fwd'),
            fx: Number(v.fx), fy: Number(v.fy), cx: Number(v.cx), cy: Number(v.cy),
            width: decoded.width, height: decoded.height, png
        });
    }
    return views;
}

export function createSpecularMaterialsHandler(deps: { segment?: SegmentImage } = {}): ToolHandler {
    return async (args, ctx) => {
        const glbPath = str(args.glbPath);
        if (!glbPath) throw new MissingInputError(SPECULAR_MATERIALS_TOOL_NAME, 'glbPath', 'the mesh to read');
        if (!fs.existsSync(glbPath)) throw new MissingInputError(SPECULAR_MATERIALS_TOOL_NAME, 'an existing glbPath', `got ${glbPath}`);
        const target = str(args.target) || FACADE_GLASS_TARGET;
        const minAgreeingViews = Math.max(1, Math.round(num(args.minAgreeingViews, 2)));
        const segment = deps.segment ?? segmenterTool();

        const referenceViewsArg = Array.isArray(args.referenceViews) ? args.referenceViews : undefined;
        let tier: 'posed' | 'self-render' | 'single-view-fallback';
        let views;
        if (referenceViewsArg && referenceViewsArg.length) {
            const posed = await readReferenceViews(referenceViewsArg);
            ctx?.reportProgress?.(`specular materials: segmenting ${posed.length} posed view(s) for "${target}"`);
            views = await segmentPosedViews(posed, target, segment, ctx?.signal);
            tier = 'posed';
        } else {
            const count = Math.max(1, Math.round(num(args.selfRenderViews, 6)));
            ctx?.reportProgress?.(`specular materials: rendering and segmenting ${count} self-rendered view(s) for "${target}"`);
            views = await gatherSelfRenderEvidence(glbPath, segment, { count, target, signal: ctx?.signal });
            tier = 'self-render';
        }

        let projection = await projectMaskedViewsToUv(glbPath, views, { minAgreeingViews });
        let agreementUsed = minAgreeingViews;
        if (projection.cellsAccepted === 0 && args.allowSingleViewFallback === true && minAgreeingViews > 1) {
            projection = await projectMaskedViewsToUv(glbPath, views, { minAgreeingViews: 1 });
            agreementUsed = 1;
            if (projection.cellsAccepted > 0) tier = 'single-view-fallback';
        }

        const tierScale = tier === 'posed' ? 1 : tier === 'self-render' ? 0.6 : 0.3;
        const label = tier === 'posed' ? 'photo-inferred' : 'generated';
        const confidence = regionConfidence(projection, tierScale);
        const totalCells = projection.gridSize * projection.gridSize;

        let baked: { glbPath: string; hadBaseColorTexture: boolean; acceptedTexels: number; totalTexels: number } | undefined;
        let bakeError: string | undefined;
        if (args.bake !== false && projection.cellsAccepted > 0) {
            try {
                const outputGlbPath = str(args.outputGlbPath) || defaultOutputPath(glbPath);
                const r = await bakeSpecularMaterials(glbPath, projection, outputGlbPath);
                baked = { glbPath: r.glbPath, hadBaseColorTexture: r.hadBaseColorTexture, acceptedTexels: r.acceptedTexels, totalTexels: r.totalTexels };
            } catch (err) {
                bakeError = err instanceof Error ? err.message : String(err);
            }
        }

        const method = tier === 'posed'
            ? `${views.length} posed view(s) of "${target}", accepted where at least ${agreementUsed} agree (photo-inferred)`
            : tier === 'single-view-fallback'
                ? `${views.length} self-rendered view(s) of "${target}"; the ${minAgreeingViews}-view floor found nothing, so a single view's read stands instead, at lower confidence (generated, self-consistency only)`
                : `${views.length} self-rendered view(s) of "${target}", accepted where at least ${agreementUsed} agree (generated: the mesh's own bake checked against itself, not independent evidence)`;

        const summary = projection.regions.length
            ? `Found ${projection.regions.length} region(s) of "${target}" (${projection.cellsAccepted} of ${projection.cellsSampled} sampled UV cells, tier: ${tier}, confidence ${confidence.toFixed(2)}).`
                + (baked ? ` Baked into ${baked.glbPath} (${baked.acceptedTexels} of ${baked.totalTexels} texels).` : bakeError ? ` Not baked: ${bakeError}` : args.bake === false ? ' Not baked (bake: false).' : '')
            : `No region of "${target}" was accepted (${projection.cellsSampled} UV cells sampled across ${views.length} view(s), tier: ${tier}).`;

        return {
            status: 'completed',
            resultPayload: {
                success: true, tier, target, minAgreeingViewsUsed: agreementUsed, viewsUsed: views.length,
                cellsSampled: projection.cellsSampled, cellsAccepted: projection.cellsAccepted, totalCells,
                regions: projection.regions.map(r => ({ bounds: r.bounds, cells: r.cells, confidence: Math.round(r.confidence * 1000) / 1000, agreeingViews: r.agreeingViews })),
                provenance: { label, confidence: Math.round(confidence * 1000) / 1000, method },
                ...(baked ? { baked } : {}), ...(bakeError ? { bakeError } : {})
            },
            summaryResult: summary
        };
    };
}

export const SPECULAR_MATERIALS_TOOL_DECLARATIONS: ToolDeclaration[] = [SPECULAR_MATERIALS_TOOL_DECLARATION];

export const specularMaterialHandlers: Array<[ToolDeclaration, ToolHandler]> = [
    [SPECULAR_MATERIALS_TOOL_DECLARATION, createSpecularMaterialsHandler()]
];
