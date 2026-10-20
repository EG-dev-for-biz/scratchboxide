/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * staged_location_material_mode: shows the active staged location build in studio clay or with its photo-inferred
 * textures (texture pass design §9). Part of the Google 3D Tiles pack (spatial-tools.ts). It runs the canvas operator
 * sb_set_staged_material_mode on the active scene, which sets stagedBuild.materialMode, the matching scene renderMode
 * (clay is renderMode 'clay', so an object built at the place is clay too; textured puts back the mode clay replaced)
 * and stagedBuildView.provenance, and nothing
 * else: the viewport loads each layer's textured twin and crossfades to it, layers without one stay clay. The overlay's
 * toggle writes the same fields, so a choice made either way is saved with the scene and survives a reload.
 */

import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { DirectDispatchOperatorEngine } from '../../../browser/generative-canvas/services/direct-dispatch-operator-engine';
import type { StagedMaterialModeResult } from '../../../browser/generative-canvas/services/operators/material-pbr-operators';
import { TEXTURE_LADDER_RUNGS } from '../../../common/spatial/texture-pass-contracts';
import type { ToolContext, ToolDeclaration, ToolHandlerOutcome } from './types';

export const STAGED_MATERIAL_MODE_TOOL = 'staged_location_material_mode';

export const STAGED_MATERIAL_MODE_DECLARATION: ToolDeclaration = {
    name: STAGED_MATERIAL_MODE_TOOL,
    description:
        'Switch the active staged location build (the scene google_3d_tiles_get_clay staged) between studio clay and real textures. ' +
        'Textured is the default: clay shows first and each layer crossfades to its textured twin from the background texture pass as it arrives, ' +
        'and layers without one stay clay. "clay" shows the whole scene in studio clay (the staged layers and any object built at the place: it sets the scene render mode to clay) and stays, across reloads, until "textured" is asked for again; "textured" puts back the render mode the clay view replaced (pbr for an object built at the place). The textures are photo-inferred (projected from Street View and the Google 3D Tiles photos, then measured palette colour or generated PBR where no photo saw a surface), ' +
        'and every texel is labelled with where it came from; provenance: true shades the textured layers by that source per texel, with a legend. ' +
        'If the texture pass is still running, each layer switches as its textures arrive; nothing waits. Changes no geometry and starts no new build. ' +
        'Use it when the user asks to see the build in clay (for example the "Show clay" suggestion) or the real textures again ("Show real textures"), not to stage a new place.',
    parameters: {
        type: 'OBJECT',
        properties: {
            mode: { type: 'STRING', enum: ['textured', 'clay'], description: '"textured" to show the photo-inferred textures where a layer has them, "clay" to go back to studio clay.' },
            provenance: { type: 'BOOLEAN', description: 'Optional: true to shade textured layers by the source of each texel (and clay layers by how they were made), false to turn that off. Omit to leave it as it is.' }
        },
        required: ['mode']
    }
};

function rungSummary(state: { layers: Array<{ retired?: boolean; textured?: { rungShares: number[]; bytes: number } }>; texturePass?: { rungShares?: number[] } }): string {
    const shares = state.texturePass?.rungShares ?? (() => {
        const ls = state.layers.filter(l => !l.retired && l.textured?.rungShares?.length);
        if (ls.length === 0) return undefined;
        const w = ls.reduce((a, l) => a + Math.max(1, l.textured!.bytes), 0);
        return TEXTURE_LADDER_RUNGS.map((_, i) => ls.reduce((a, l) => a + (l.textured!.rungShares[i] ?? 0) * Math.max(1, l.textured!.bytes), 0) / w);
    })();
    if (!shares) return '';
    const parts = TEXTURE_LADDER_RUNGS.map((name, i) => ({ name, s: shares[i] ?? 0 })).filter(x => x.s >= 0.005).map(x => `${x.name} ${Math.round(x.s * 100)}%`);
    return parts.length > 0 ? ` Texels by source: ${parts.join(', ')}.` : '';
}

export async function runStagedMaterialModeTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const active = ctx?.request?.activeArtifact;
    if (!active || active.type !== '3d-scene' || !active.data) {
        throw new Error(`${STAGED_MATERIAL_MODE_TOOL}: no 3D scene is open. Stage a place with google_3d_tiles_get_clay first.`);
    }
    const engine = new DirectDispatchOperatorEngine(active.data as Scene3DData);
    const params: Record<string, unknown> = { mode: args.mode };
    if (args.provenance !== undefined && args.provenance !== null) params.provenance = args.provenance;
    const r = engine.executeOperator<Record<string, unknown>, StagedMaterialModeResult>('sb_set_staged_material_mode', params);
    if (!r.success || !r.data) throw new Error(`${STAGED_MATERIAL_MODE_TOOL}: ${r.error ?? 'the scene could not be switched'}`);
    const res = r.data;
    const data = engine.getSceneData();
    const tp = res.texturePass;
    const passing = !!tp && (tp.status === 'running' || tp.status === 'pending');
    const staged = (data as Scene3DData & { stagedBuild?: Parameters<typeof rungSummary>[0] }).stagedBuild!;
    let summary: string;
    if (res.mode === 'clay') {
        summary = `Showing the staged build in studio clay${res.texturedLayers > 0 ? ` (real textures stay available for ${res.texturedLayers} of ${res.layers} layers)` : ''}.`;
    } else if (res.texturedLayers === 0) {
        summary = passing
            ? `Real textures asked for: the texture pass is still running (${tp!.layersDone} of ${tp!.layersTotal} layers); each layer switches as its textures arrive, the scene stays clay until then.`
            : `No layer of this staged build has textures${tp ? ` (texture pass ${tp.status})` : ''}, so it stays in studio clay.`;
    } else {
        summary = `Showing photo-inferred textures on ${res.texturedLayers} of ${res.layers} layers (labelled per texel); the rest stay clay.${rungSummary(staged)}`
            + (passing ? ` The texture pass is still running (${tp!.layersDone} of ${tp!.layersTotal} layers); the others switch as their textures arrive.` : '');
    }
    // The scene's render mode moves with the choice (clay clays an object standing at the place too); said as it is.
    if (res.renderMode !== undefined) summary += ` Scene render mode: ${res.renderMode}.`;
    if (res.provenance !== undefined) summary += res.provenance ? ' Provenance shading is on.' : ' Provenance shading is off.';
    const artifact: CanvasArtifact = {
        ...active,
        data,
        summary,
        version: ((active as { version?: number }).version || 1) + 1
    } as CanvasArtifact;
    return { resultPayload: { success: true, ...res, artifact }, summaryResult: summary };
}
