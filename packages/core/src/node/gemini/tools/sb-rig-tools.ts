/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { SbRigService, SbRigError, type Point3, type SbRigParams } from '../../3d-engine/sb-rig-service';
import type { ToolDeclaration, ToolHandler, ToolParameterSchema } from './types';

const POINT: ToolParameterSchema = { type: 'ARRAY', description: '[x, y, z] in the GLB scene (world) space.', items: { type: 'NUMBER' } };

const PARAM_SCHEMA: Record<keyof SbRigParams, ToolParameterSchema> = {
    weldFrac: { type: 'NUMBER', description: 'Seam weld tolerance as a fraction of the bbox diagonal (1e-5).' },
    refineEdgeMultiple: { type: 'NUMBER', description: 'Analysis graph splits edges longer than this x median edge (2; 0 = off).' },
    agdSamples: { type: 'NUMBER', description: 'Geodesic sources for the average-geodesic-distance field (48).' },
    bandFrac: { type: 'NUMBER', description: 'Minimum band width as a fraction of the slicing range (0.015).' },
    bandEdgeMultiple: { type: 'NUMBER', description: 'Bands span at least this many median edges (3).' },
    loopContractRatio: { type: 'NUMBER', description: 'Loops shorter than this x ring radius are discretisation artifacts (3).' },
    minNodeFrac: { type: 'NUMBER', description: 'Smallest Reeb node as a fraction of vertices (0.0005).' },
    minBranchFrac: { type: 'NUMBER', description: 'Leaves protruding less than this x geodesic diameter are pruned (0.04). Raise to drop bumps, lower to keep short digits.' },
    hubMergeFrac: { type: 'NUMBER', description: 'Splits closer than this x diameter merge into one hub (0.05).' },
    jointDeviationFrac: { type: 'NUMBER', description: 'Centreline deviation that earns a joint, x diameter (0.02). Lower = more joints.' },
    radiusWeight: { type: 'NUMBER', description: 'Weight of thickness changes in joint placement (0.5).' },
    bendThresholdRad: { type: 'NUMBER', description: 'Bend angle that earns a joint, radians (0.35).' },
    minBoneFrac: { type: 'NUMBER', description: 'Shortest bone, x diameter (0.025).' },
    maxBoneFrac: { type: 'NUMBER', description: 'Longest bone before subdivision, x diameter (0.25).' },
    minLeafChainSegments: { type: 'NUMBER', description: 'Minimum weighted joints on every leaf chain (3).' },
    blendScale: { type: 'NUMBER', description: 'Skin blend width at each joint, x local ring radius (0.6).' },
    emitTipJoints: { type: 'BOOLEAN', description: 'Add zero-weight end-effector joints at every tip (true).' },
};

export const SB_RIG_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'sbrig_auto_rig',
        description:
            'SB-Rig: rig ANY mesh (.glb) with a skeleton and 4-bone skin weights discovered from its geometry: hands, creatures, ' +
            'tentacles, plants, branching props. No preset skeleton, no external tools; images, UVs and materials are kept byte for byte. ' +
            'Joints are named Root and Chain<k>Seg<i>; read the returned chains (with end positions), then call again with `rename` to give ' +
            'them meaning (e.g. {from:"Chain3", to:"LeftIndex"} -> LeftIndex1..n), `rootHint` to start the hierarchy at a cut end (e.g. a ' +
            'forearm stump), and `chainHints` for digits fused into the body (e.g. fingers curled into a palm) picked from a render.',
        parameters: {
            type: 'OBJECT',
            properties: {
                inputGlbPath: { type: 'STRING', description: 'Path to the binary glTF 2.0 (.glb) to rig. Must not already contain a skin.' },
                outputGlbPath: { type: 'STRING', description: 'Where to write the skinned .glb. Defaults to <input>_sbrig.glb.' },
                rootHint: { ...POINT, description: 'World point near where the hierarchy should start; omit for the geodesic centre.' },
                chainHints: {
                    type: 'ARRAY',
                    description: 'Extra chains, each an ordered list of [x,y,z] points from base to tip. Surface points are pulled to the local axis; interior points are used as given.',
                    items: { type: 'ARRAY', items: POINT },
                },
                rename: {
                    type: 'ARRAY',
                    description: 'Ordered renames. `from` is a chain name (renames its joints to <to>1..n) or an exact joint name.',
                    items: { type: 'OBJECT', properties: { from: { type: 'STRING' }, to: { type: 'STRING' } }, required: ['from', 'to'] },
                },
                params: { type: 'OBJECT', description: 'Optional dimensionless tuning (defaults are mesh-scale independent).', properties: PARAM_SCHEMA },
            },
            required: ['inputGlbPath'],
        },
    },
];

function toPoint(value: unknown, label: string): Point3 {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new SbRigError(`${label} must be [x, y, z]`, 'invalid-input');
    }
    return [value[0], value[1], value[2]];
}

const service = new SbRigService();

export const sbRigHandlers: Record<string, ToolHandler> = {
    sbrig_auto_rig: async args => {
        try {
            if (typeof args.inputGlbPath !== 'string' || !args.inputGlbPath) throw new SbRigError('inputGlbPath is required', 'invalid-input');
            const chainHints = Array.isArray(args.chainHints)
                ? args.chainHints.map((hint, i) => {
                      if (!Array.isArray(hint)) throw new SbRigError(`chainHints[${i}] must be a list of points`, 'invalid-input');
                      return hint.map((p, k) => toPoint(p, `chainHints[${i}][${k}]`));
                  })
                : undefined;
            const rename = Array.isArray(args.rename)
                ? args.rename.map((r, i) => {
                      const entry = r as { from?: unknown; to?: unknown };
                      if (typeof entry?.from !== 'string' || typeof entry?.to !== 'string') throw new SbRigError(`rename[${i}] needs string from/to`, 'invalid-input');
                      return { from: entry.from, to: entry.to };
                  })
                : undefined;
            const result = await service.rig({
                inputGlbPath: args.inputGlbPath,
                outputGlbPath: typeof args.outputGlbPath === 'string' && args.outputGlbPath ? args.outputGlbPath : undefined,
                rootHint: args.rootHint !== undefined ? toPoint(args.rootHint, 'rootHint') : undefined,
                chainHints,
                rename,
                params: (args.params && typeof args.params === 'object' ? args.params : undefined) as SbRigParams | undefined,
            });
            const { report } = result;
            const fmt = (p?: number[]) => (p ? `[${p.map(v => v.toFixed(3)).join(', ')}]` : '?');
            const chains = report.chains
                .map(c => `${c.name} (${c.leaf ? 'leaf' : 'inner'}${c.hinted ? ', hinted' : ''}, ${c.joints.length} joints, from ${c.parentJoint}, ends ${fmt(c.endPosition)})`)
                .join('; ');
            return {
                status: 'completed',
                resultPayload: {
                    success: true,
                    outputGlbPath: result.outputGlbPath,
                    reportPath: result.reportPath,
                    joints: report.joints,
                    chains: report.chains,
                    stats: report.stats,
                    warnings: report.warnings,
                },
                summaryResult:
                    `SB-Rig rigged ${report.stats.inputVertices} vertices in ${Number(report.timingsMs.total).toFixed(0)} ms: ` +
                    `${report.stats.jointCount} joints, ${report.stats.chainCount} chains (${report.stats.leafChainCount} leaves), root from ${report.stats.rootSource}. ` +
                    `Chains: ${chains}. Skinned GLB: ${result.outputGlbPath}` +
                    (report.warnings.length ? `. Warnings: ${report.warnings.join(' | ')}` : ''),
            };
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return {
                status: 'failed',
                resultPayload: { success: false, error, kind: err instanceof SbRigError ? err.kind : 'internal' },
                summaryResult: `SB-Rig failed: ${error}`,
            };
        }
    },
};
