/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportStagedSwitchProblems, stagedBuildingPipelineEnv, stagedDistrictMode, stagedModelService, stagedSwitchProblems } from '../src/node/3d-engine/staged-location/staged-switches';
import { districtMassingEnabled, proceduralDistrictEnabled } from '../src/node/3d-engine/staged-location/district-massing';
import { stagedPipelineK } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import { parseStagedLocationArgs } from '../src/node/3d-engine/staged-location/staged-location-tool';
import { InvalidInputError } from '../src/common/errors/pipeline-errors';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('staged build switches: one meaning each (2026-10-30)', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('reads the building pipeline from SCRATCHBOX_STAGED_BUILDING_PIPELINE only: j or k', () => {
        expect(stagedBuildingPipelineEnv(env({}))).toBeUndefined();
        expect(stagedBuildingPipelineEnv(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: ' K ' }))).toBe('k');
        expect(stagedBuildingPipelineEnv(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'j' }))).toBe('j');
        // the retired letters and the retired switch are not read
        for (const letter of ['g', 'h', 'i', 'e']) expect(stagedBuildingPipelineEnv(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: letter })), letter).toBeUndefined();
        expect(stagedBuildingPipelineEnv(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'k' }))).toBeUndefined();
        expect(stagedPipelineK({}, env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'k' }))).toBe(true);
        expect(stagedPipelineK({}, env({ SCRATCHBOX_STAGED_PROCEDURAL: 'k' }))).toBe(false);
        // the request's own pipeline wins over the environment
        expect(stagedPipelineK({ pipeline: 'j' }, env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'k' }))).toBe(false);
        expect(stagedPipelineK({ pipeline: 'K' }, env({}))).toBe(true);
    });

    it('picks pipeline J\'s model service from the request, else SCRATCHBOX_STAGED_MODEL_SERVICE, else Meshy', () => {
        expect(stagedModelService({}, env({}))).toBe('meshy');
        expect(stagedModelService({}, env({ SCRATCHBOX_STAGED_MODEL_SERVICE: ' Trellis ' }))).toBe('trellis');
        expect(stagedModelService({ modelService: 'meshy' }, env({ SCRATCHBOX_STAGED_MODEL_SERVICE: 'trellis' }))).toBe('meshy');
        expect(stagedModelService({ modelService: 'trellis' }, env({}))).toBe('trellis');
        expect(stagedModelService({ modelService: 'triposr' }, env({ SCRATCHBOX_STAGED_MODEL_SERVICE: 'nope' }))).toBe('meshy');
    });

    it('reads the district from SCRATCHBOX_STAGED_DISTRICT only, massing by default', () => {
        const cases: Array<[Record<string, string>, string, boolean, boolean]> = [
            [{}, 'massing', true, false],
            [{ SCRATCHBOX_STAGED_DISTRICT: 'scan' }, 'scan', false, false],
            [{ SCRATCHBOX_STAGED_DISTRICT: ' Rebuilt ' }, 'rebuilt', true, true],
            [{ SCRATCHBOX_STAGED_DISTRICT: 'procedural' }, 'massing', true, false],
            // the retired switches no longer change the district
            [{ SCRATCHBOX_STAGED_PROCEDURAL: '1' }, 'massing', true, false],
            [{ SCRATCHBOX_STAGED_DISTRICT_MASSING: '0' }, 'massing', true, false]
        ];
        for (const [vars, mode, massing, rebuilt] of cases) {
            expect(stagedDistrictMode(env(vars)), JSON.stringify(vars)).toBe(mode);
            expect(districtMassingEnabled(env(vars)), JSON.stringify(vars)).toBe(massing);
            expect(proceduralDistrictEnabled(env(vars)), JSON.stringify(vars)).toBe(rebuilt);
        }
    });

    it('names the setting that replaces a retired switch or letter, and the values a switch does not take', () => {
        expect(stagedSwitchProblems(env({}))).toEqual([]);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'k', SCRATCHBOX_STAGED_MODEL_SERVICE: 'trellis', SCRATCHBOX_STAGED_DISTRICT: 'rebuilt', SCRATCHBOX_STAGED_GEOMETRY: 'f' }))).toEqual([]);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'J' })))
            .toEqual(['SCRATCHBOX_STAGED_PROCEDURAL=J is no longer read (replaced 2026-10-30): set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j.']);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'i' }))[0]).toMatch(/set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j and SCRATCHBOX_STAGED_MODEL_SERVICE=trellis \(pipeline I is now pipeline J with the Trellis model service\)\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'g' }))[0]).toMatch(/set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j \(pipelines G and H were retired on 2026-10-30; pipeline J is the procedural build\)\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: '1' }))[0]).toMatch(/set SCRATCHBOX_STAGED_DISTRICT=rebuilt\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_DISTRICT_MASSING: '0' }))[0]).toMatch(/set SCRATCHBOX_STAGED_DISTRICT=scan\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_DISTRICT_MASSING: '1' }))[0]).toMatch(/set SCRATCHBOX_STAGED_DISTRICT=massing \(the default\)\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'h' })))
            .toEqual(['SCRATCHBOX_STAGED_BUILDING_PIPELINE=h is ignored: pipelines G and H were retired on 2026-10-30; pipeline J is the procedural build; set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j.']);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'i' }))[0]).toMatch(/^SCRATCHBOX_STAGED_BUILDING_PIPELINE=i is ignored: pipeline I is now pipeline J with the Trellis model service; set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j and SCRATCHBOX_STAGED_MODEL_SERVICE=trellis\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'e' })))
            .toEqual(['SCRATCHBOX_STAGED_BUILDING_PIPELINE takes j, k; "e" is ignored.']);
        // a name on the object prototype is not a retired letter
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'constructor' }))).toEqual(['SCRATCHBOX_STAGED_BUILDING_PIPELINE takes j, k; "constructor" is ignored.']);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_MODEL_SERVICE: 'triposr' })))
            .toEqual(['SCRATCHBOX_STAGED_MODEL_SERVICE takes meshy, trellis; "triposr" is ignored, so pipeline J uses Meshy.']);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_GEOMETRY: 'G' }))[0]).toMatch(/^SCRATCHBOX_STAGED_GEOMETRY=g is ignored: .*; set SCRATCHBOX_STAGED_BUILDING_PIPELINE=j\.$/);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_DISTRICT: 'procedural' })))
            .toEqual(['SCRATCHBOX_STAGED_DISTRICT takes scan, massing, rebuilt; "procedural" is ignored, so a district has its massing.']);
        expect(stagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'k', SCRATCHBOX_STAGED_DISTRICT_MASSING: '0' }))).toHaveLength(2);
    });

    it('reports once per process', () => {
        const said: string[] = [];
        reportStagedSwitchProblems(env({ SCRATCHBOX_STAGED_PROCEDURAL: 'k' }), m => said.push(m));
        reportStagedSwitchProblems(env({ SCRATCHBOX_STAGED_DISTRICT_MASSING: '0' }), m => said.push(m));
        expect(said).toEqual(['[staged-location] SCRATCHBOX_STAGED_PROCEDURAL=k is no longer read (replaced 2026-10-30): set SCRATCHBOX_STAGED_BUILDING_PIPELINE=k.']);
    });

    it('the staged tool takes the one building\'s default pipeline from the new switch only', () => {
        const isolated = () => parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'q', isolate: true }).request;
        vi.stubEnv('SCRATCHBOX_STAGED_BUILDING_PIPELINE', '');
        vi.stubEnv('SCRATCHBOX_STAGED_PROCEDURAL', '');
        expect(isolated()).toMatchObject({ pipeline: 'k' });
        // 'j' makes the procedural build the default: no 'k', a procedural build
        vi.stubEnv('SCRATCHBOX_STAGED_BUILDING_PIPELINE', 'j');
        expect(isolated().pipeline).toBeUndefined();
        expect(isolated().procedural).toBe(true);
        // a retired letter, in the new switch or the old one, changes nothing
        vi.stubEnv('SCRATCHBOX_STAGED_BUILDING_PIPELINE', 'h');
        expect(isolated()).toMatchObject({ pipeline: 'k' });
        vi.stubEnv('SCRATCHBOX_STAGED_BUILDING_PIPELINE', '');
        vi.stubEnv('SCRATCHBOX_STAGED_PROCEDURAL', 'j');
        expect(isolated()).toMatchObject({ pipeline: 'k' });
        expect(isolated().procedural).toBeUndefined();
    });

    it('the staged tool runs \'i\' as J with Trellis, takes a model service, and refuses the retired G and H', () => {
        const parse = (args: Record<string, unknown>) => parseStagedLocationArgs('google_3d_tiles_get_clay', { query: 'q', isolate: true, ...args }).request;
        expect(parse({ pipeline: 'i' })).toMatchObject({ pipeline: 'j', modelService: 'trellis', procedural: true });
        expect(parse({ pipeline: 'i', modelService: 'meshy' })).toMatchObject({ pipeline: 'j', modelService: 'meshy' });
        expect(parse({ pipeline: 'j', modelService: 'trellis' })).toMatchObject({ pipeline: 'j', modelService: 'trellis', procedural: true });
        expect(parse({ pipeline: 'j' })).not.toHaveProperty('modelService');
        expect(parse({ procedural: true, modelService: 'other' })).not.toHaveProperty('modelService');
        for (const letter of ['g', 'h', 'G']) {
            expect(() => parse({ pipeline: letter }), letter).toThrow(InvalidInputError);
            expect(() => parse({ pipeline: letter }), letter).toThrow(/retired on 2026-10-30/);
        }
    });
});
