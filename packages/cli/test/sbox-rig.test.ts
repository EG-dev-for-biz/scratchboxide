/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../src/index';
import { parseRigArgs } from '../src/commands/rig';
import { SbRigService } from '../../core/src/node/3d-engine/sb-rig-service';
import { NativeCppCompilerService } from '../../core/src/node/3d-engine/native-compiler-service';

const REPO = path.resolve(__dirname, '../../..');
const REAL_HAND = path.join(REPO, 'public/models/sbhuman_hand_hyperreal.glb');
const OUT = path.join(REPO, 'test-results/sbox-rig/hand_rigged.glb');
// The SB-Human hand GLB is a gitignored local asset. Without it these cases rig the SB-Rig runner's own synthetic
// 5-digit claw (UV-mapped, one material), generated once into the work directory.
let HAND = REAL_HAND;

/** Writes the SB-Rig runner's synthetic 5-digit claw into `dir` and returns its path. */
async function syntheticClawGlb(dir: string): Promise<string> {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'fixture_claw5.glb');
    const binary = await new SbRigService().ensureBinary();
    const exec = await new NativeCppCompilerService().executeBinary(binary, ['--synthetic', 'claw', '--digits', '5', '--synthetic-out', out,
        '--output', path.join(dir, 'fixture_claw5_rigged.glb')], dir);
    if (exec.exitCode !== 0) throw new Error(`SB-Rig synthetic claw generation failed: ${exec.stderr}`);
    return out;
}

beforeAll(async () => {
    if (!fs.existsSync(REAL_HAND)) HAND = await syntheticClawGlb(path.dirname(OUT));
}, 300_000);

describe('sbox rig', () => {
    it('parses hints, renames, params and --flag=value forms (negative coordinates included)', () => {
        const opts = parseRigArgs([
            'hand.glb', '-o', 'out.glb', '--root-hint', '-0.32,-0.92,-0.06', '--chain-hint=0,0,0;1,1,1;2,2,2',
            '--rename', 'Chain3=LeftIndex', '--param-minBranchFrac', '0.06', '--param-emitTipJoints=false', '--json',
        ]);
        expect(path.basename(opts.inputGlbPath!)).toBe('hand.glb');
        expect(path.basename(opts.outputGlbPath!)).toBe('out.glb');
        expect(opts.rootHint).toEqual([-0.32, -0.92, -0.06]);
        expect(opts.chainHints).toEqual([[[0, 0, 0], [1, 1, 1], [2, 2, 2]]]);
        expect(opts.rename).toEqual([{ from: 'Chain3', to: 'LeftIndex' }]);
        expect(opts.params).toEqual({ minBranchFrac: 0.06, emitTipJoints: false });
        expect(opts.json).toBe(true);
        expect(() => parseRigArgs(['--root-hint', '1,2'])).toThrow(/x,y,z/);
        expect(() => parseRigArgs([])).toThrow(/input .glb required/);
    });

    it('rigs a GLB end to end through runCli', async () => {
        fs.rmSync(OUT, { force: true });
        process.exitCode = undefined;
        await runCli(['rig', HAND, '-o', OUT, '--rename', 'Root=Palm']);
        expect(process.exitCode).toBeUndefined();
        expect(fs.existsSync(OUT)).toBe(true);
        const report = JSON.parse(fs.readFileSync(OUT.replace(/\.glb$/, '.sbrig.json'), 'utf8'));
        expect(report.joints[0].name).toBe('Palm');
        expect(report.stats.leafChainCount).toBeGreaterThanOrEqual(5);
    });
});
