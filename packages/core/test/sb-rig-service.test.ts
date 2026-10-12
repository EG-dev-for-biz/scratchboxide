/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** SbRigService (compiled native runner) and the `sbrig_auto_rig` agent tool, on a real textured GLB. */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SbRigService, SbRigError, buildSbRigArgs, parseSbRigTelemetry } from '../src/node/3d-engine/sb-rig-service';
import { sbRigHandlers } from '../src/node/gemini/tools/sb-rig-tools';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { readSkinnedGlb, renderPreviewPng, principalAxes } from './helpers/skinned-glb-preview';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/sb-rig-service');
const HAND = path.join(REPO, 'public/models/sbhuman_hand_hyperreal.glb');

describe('SbRigService', () => {
    const service = new SbRigService();

    it('rigs a GLB path with a root hint and renames, returning the skinned GLB and report', async () => {
        fs.mkdirSync(WORK, { recursive: true });
        const outputGlbPath = path.join(WORK, 'hand.glb');
        const first = await service.rig({ inputGlbPath: HAND, outputGlbPath });
        const wrist = first.report.chains.find(c => c.leaf && c.endPosition && c.joints.length > 0)!;
        const result = await service.rig({
            inputGlbPath: HAND,
            outputGlbPath,
            rootHint: wrist.endPosition as [number, number, number],
            rename: { Root: 'Origin', Chain1: 'Spine' },
            includeTree: true,
        });
        expect(result.telemetry.status).toBe('success');
        expect(result.report.stats.rootSource).toBe('root-hint');
        expect(result.report.joints[0].name).toBe('Origin');
        expect(result.report.chains[0].name).toBe('Spine');
        expect(Array.isArray(result.report.tree)).toBe(true);
        const glb = readSkinnedGlb(result.glbBuffer);
        expect(glb.jointNames[0]).toBe('Origin');
        const [major, middle] = principalAxes(glb.positions);
        fs.mkdirSync(path.join(REPO, 'test-results/screenshots'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'test-results/screenshots/sb-rig-service_hand_rooted.png'),
            renderPreviewPng([{ doc: glb, right: middle.map(x => -x), up: major }], 560));
    });

    it('accepts a GLB buffer and reports invalid input as SbRigError(invalid-input)', async () => {
        const result = await service.rig({ inputGlbBuffer: fs.readFileSync(HAND), outputGlbPath: path.join(WORK, 'from_buffer.glb') });
        expect(result.report.stats.jointCount).toBeGreaterThan(10);
        await expect(service.rig({ inputGlbPath: result.outputGlbPath })).rejects.toMatchObject({ kind: 'invalid-input' });
        await expect(service.rig({ inputGlbPath: HAND, rename: { NoSuchChain: 'X' } })).rejects.toThrow(/matches no chain or joint/);
    });

    it('builds argv without a shell and validates options before running', () => {
        const args = buildSbRigArgs('in.glb', 'out.glb', 'out.json', {
            params: { minBranchFrac: 0.06, emitTipJoints: false },
            rootHint: [0, -1.5, 0.25],
            chainHints: [[[0, 0, 0], [1, 2, 3]]],
            rename: [{ from: 'Chain2', to: 'Tail' }],
        });
        expect(args).toEqual([
            '--input', 'in.glb', '--output', 'out.glb', '--report', 'out.json',
            '--param-minBranchFrac', '0.06', '--param-emitTipJoints', 'false',
            '--root-hint', '0,-1.5,0.25', '--chain-hint', '0,0,0;1,2,3', '--rename', 'Chain2=Tail',
        ]);
        expect(() => buildSbRigArgs('a', 'b', 'c', { params: { bogus: 1 } as any })).toThrow(SbRigError);
        expect(() => buildSbRigArgs('a', 'b', 'c', { rootHint: [0, NaN, 0] })).toThrow(/three finite numbers/);
        expect(() => buildSbRigArgs('a', 'b', 'c', { chainHints: [[[0, 0, 0]]] })).toThrow(/at least 2 points/);
        expect(parseSbRigTelemetry('noise\n[TELEMETRY] status=error kind=invalid-input message="bad \\"thing\\" here"\n')).toEqual({
            status: 'error', kind: 'invalid-input', message: 'bad "thing" here',
        });
    });
});

describe('sbrig_auto_rig agent tool', () => {
    it('is registered in the default registry and returns chains the agent can act on', async () => {
        expect(createDefaultToolRegistry().has('sbrig_auto_rig')).toBe(true);
        const ok = await sbRigHandlers.sbrig_auto_rig(
            { inputGlbPath: HAND, outputGlbPath: path.join(WORK, 'tool.glb'), rename: [{ from: 'Root', to: 'Palm' }], params: { minBranchFrac: 0.05 } },
            {} as any
        );
        expect(ok.status).toBe('completed');
        expect(ok.resultPayload.success).toBe(true);
        expect(ok.summaryResult).toMatch(/joints, \d+ chains/);
        expect(ok.summaryResult).toContain('Chain');
        expect((ok.resultPayload.joints as any[])[0].name).toBe('Palm');

        const bad = await sbRigHandlers.sbrig_auto_rig({ inputGlbPath: HAND, rootHint: [1, 2] }, {} as any);
        expect(bad.status).toBe('failed');
        expect(bad.resultPayload).toMatchObject({ success: false, kind: 'invalid-input' });
    });
});
