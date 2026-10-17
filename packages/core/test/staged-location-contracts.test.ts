/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged-location contracts: the JSON Schema is well-formed, every contract's valid example passes, each kind of
 * invalid example fails with one precise message, the user's decisions are encoded (degrade ladder, labels, vision
 * model, Street View limit, correction tolerance, relief default), and tile_refine's per-vertex provenance is read in
 * bands, never by an exact-zero test. The outcome table is rendered to
 * test-results/screenshots/staged/contracts_validation.png.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROVENANCE_LEGEND,
    MAX_STREET_VIEW_IMAGES_PER_BUILDING,
    NON_MEASURED_PROVENANCE_LABELS,
    PHOTO_CORRECTION_TOLERANCE_M,
    PHOTO_INFERRED_FORBIDDEN_WORDS,
    PROUD_BLOCK_BANDS,
    PROVENANCE,
    PROVENANCE_BACKGROUND,
    RECTIFY_DISPLACEMENT_BANDS,
    RELIEF_HEIGHT_CARVED_MIN_M,
    SCAN_FIT_ERROR_TRANSIENT,
    STAGED_CONTRACT_NAMES,
    STAGED_DEGRADE_LADDER,
    STAGED_LOCATION_SCHEMA,
    STAGED_SUMMARY_LIMITS,
    STAGED_SUMMARY_RULES,
    STAGED_VISION_MODEL_DEFAULT,
    TILE_REFINE_RELIEF_DEFAULT,
    TILE_REFINE_VERTEX_ATTRIBUTES,
    classifyRemeshVertex,
    schemaClosure,
    validateContract,
    type DegradationRecord,
    type StagedSchemaName
} from '../src/common/spatial/staged-location-contracts';
import * as fx from './helpers/staged-location-fixtures';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { REPO_ROOT } from './helpers/requirements';

/** Every outcome, for the screenshot. */
const outcomes: Array<{ group: string; title: string; contract: string; messages: string[] }> = [];

function refsIn(value: unknown): string[] {
    const refs: string[] = [];
    JSON.stringify(value, (key, v) => { if (key === '$ref') refs.push(v as string); return v; });
    return refs;
}

describe('STAGED_LOCATION_SCHEMA', () => {
    const defs = STAGED_LOCATION_SCHEMA.definitions as Record<string, unknown>;

    it('is a draft-07 document whose $refs all resolve', () => {
        expect(STAGED_LOCATION_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');
        // the design's 51 definitions, plus structurePick (shared by the build state and the result) and vertexProvenance
        expect(Object.keys(defs)).toHaveLength(71); // 62 plus the four tree LOD definitions plus the five texture pass definitions
        const targets = new Set(refsIn(STAGED_LOCATION_SCHEMA));
        const missing = [...targets].filter(r => !(r.replace('#/definitions/', '') in defs) || !r.startsWith('#/definitions/'));
        expect(missing).toEqual([]);
        expect(targets.size).toBeGreaterThanOrEqual(39);
        for (const name of STAGED_CONTRACT_NAMES) expect(defs[name], name).toBeDefined();
    });

    it('inlines the vision reply schema self-contained, non-recursive and under 4.5 KB', () => {
        const closure = schemaClosure('VisionOrnamentReply');
        expect(Object.keys(closure.definitions).sort()).toEqual(['VisionOrnamentReply', 'compactBox', 'compactElement', 'compactLeafOp']);
        for (const r of refsIn(closure.definitions)) expect(closure.definitions[r.replace('#/definitions/', '')], r).toBeDefined();
        // no definition reaches itself
        const reaches = (from: string, target: string, seen = new Set<string>()): boolean =>
            refsIn(closure.definitions[from]).map(r => r.replace('#/definitions/', '')).some(n => n === target || (!seen.has(n) && (seen.add(n), reaches(n, target, seen))));
        for (const name of Object.keys(closure.definitions)) expect(reaches(name, name), name).toBe(false);
        const bytes = Buffer.byteLength(JSON.stringify({ definitions: closure.definitions }));
        expect(bytes).toBe(4095);
        expect(Buffer.byteLength(JSON.stringify(closure))).toBeLessThan(4.5 * 1024);
    });
});

describe('validateContract: valid examples pass', () => {
    it.each(fx.validExamples().map(([name, value], i) => [`${name} #${i}`, name, value] as const))('%s', (_title, name, value) => {
        const messages = validateContract(name as StagedSchemaName, value);
        outcomes.push({ group: 'valid', title: 'valid example', contract: name, messages });
        expect(messages).toEqual([]);
        // the same verdict after a JSON round trip: what native writers and the SSE wire carry
        expect(validateContract(name as StagedSchemaName, JSON.parse(JSON.stringify(value)))).toEqual([]);
    });
});

interface InvalidCase { kind: string; name: StagedSchemaName; make: () => unknown; message: string }

const INVALID: InvalidCase[] = [
    {
        kind: 'type', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); (v.counts as Record<string, unknown>).vertices = '1124'; return v; },
        message: 'StructureFit.counts.vertices: expected integer, got string "1124"'
    },
    {
        kind: 'integer', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); v.primitives[1].buildOrder = 1.5; return v; },
        message: 'StructureFit.primitives[1].buildOrder: expected integer, got 1.5'
    },
    {
        kind: 'finite number', name: 'StagedNodeExtras',
        make: () => { const v = fx.treeNodeExtras(); v.sb.reveal.durationShare = NaN; return v; },
        message: 'StagedNodeExtras.sb.reveal.durationShare: expected a finite number, got NaN'
    },
    {
        kind: 'type at the root', name: 'StageEvent', make: () => null,
        message: 'StageEvent: expected object, got null'
    },
    {
        kind: 'required', name: 'StagedBuildState',
        make: () => { const v: Partial<ReturnType<typeof fx.stagedBuildState>> = fx.stagedBuildState(); delete v.runId; return v; },
        message: 'StagedBuildState: required property "runId" is missing'
    },
    {
        kind: 'required (the scene artifact)', name: 'StagedLocationResult',
        make: () => { const v: Partial<ReturnType<typeof fx.stagedLocationResult>> = fx.stagedLocationResult(); delete v.artifact; return v; },
        message: 'StagedLocationResult: required property "artifact" is missing'
    },
    {
        kind: 'additionalProperties: false (no run ids in GLB bytes)', name: 'StagedNodeExtras',
        make: () => { const v = fx.detailNodeExtras(); (v.sb as Record<string, unknown>).runId = fx.RUN_ID; return v; },
        message: 'StagedNodeExtras.sb: property "runId" is not allowed'
    },
    {
        kind: 'additionalProperties: schema', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); (v.timingsMs as Record<string, unknown>).fit = '1.2 s'; return v; },
        message: 'StructureFit.timingsMs.fit: expected number, got string "1.2 s"'
    },
    {
        kind: 'const (schema version)', name: 'StructureFit',
        make: () => ({ ...fx.structureFit(), schema: 'scratchbox.structure-fit/1' }),
        message: 'StructureFit.schema: must be "scratchbox.structure-fit/2", got "scratchbox.structure-fit/1"'
    },
    {
        kind: 'const (a hard failure throws, it is never a result)', name: 'StagedLocationResult',
        make: () => ({ ...fx.stagedLocationResult(), success: false }),
        message: 'StagedLocationResult.success: must be true, got false'
    },
    {
        kind: 'const (retry tool)', name: 'DegradationRecord',
        make: () => { const v = fx.visionDegradation(); (v.retry as Record<string, unknown>).tool = 'google_3d_tiles_get_textured'; return v; },
        message: 'DegradationRecord.retry.tool: must be "google_3d_tiles_get_clay", got "google_3d_tiles_get_textured"'
    },
    {
        kind: 'enum', name: 'StagedBuildState',
        make: () => ({ ...fx.stagedBuildState(), runState: 'paused' }),
        message: 'StagedBuildState.runState: "paused" is not one of "running", "finished", "stopped", "failed", "interrupted"'
    },
    {
        kind: 'enum (numbers)', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); (v.surfaces[1].chart as { cylinder: Record<string, unknown> }).cylinder.normalSign = 0; return v; },
        message: 'StructureFit.surfaces[1].chart.cylinder.normalSign: 0 is not one of 1, -1'
    },
    {
        kind: 'maximum', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); v.elements[0].provenance.confidence = 1.2; return v; },
        message: 'OrnamentSpec.elements[0].provenance.confidence: 1.2 is above the maximum 1'
    },
    {
        kind: 'maximum (array item)', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); v.elements[0].evidence[0].box1000 = [140, 60, 210, 1200]; return v; },
        message: 'OrnamentSpec.elements[0].evidence[0].box1000[3]: 1200 is above the maximum 1000'
    },
    {
        kind: 'exclusiveMinimum', name: 'StagedNodeExtras',
        make: () => { const v = fx.treeNodeExtras(); v.sb.reveal.durationShare = 0; return v; },
        message: 'StagedNodeExtras.sb.reveal.durationShare: must be greater than 0, got 0'
    },
    {
        kind: 'minItems', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); (v.frame as unknown as Record<string, unknown>).origin = [0, 0]; return v; },
        message: 'StructureFit.frame.origin: has 2 items, needs at least 3'
    },
    {
        kind: 'maxItems (60 elements)', name: 'VisionOrnamentReply',
        make: () => { const v = fx.visionReply(); v.elements = Array.from({ length: 61 }, () => v.elements[0]); return v; },
        message: 'VisionOrnamentReply.elements: has 61 items, allows at most 60'
    },
    {
        kind: 'maxItems (3 evidence boxes)', name: 'VisionOrnamentReply',
        make: () => { const v = fx.visionReply(); v.elements[0].ev = Array.from({ length: 4 }, () => [1, 100, 100, 200, 200]); return v; },
        message: 'VisionOrnamentReply.elements[0].ev: has 4 items, allows at most 3'
    },
    {
        kind: 'maxLength (digest kept by chat history)', name: 'StagedLocationResult',
        make: () => ({ ...fx.stagedLocationResult(), digest: 'x'.repeat(201) }),
        message: 'StagedLocationResult.digest: is 201 characters long, allows at most 200'
    },
    {
        kind: 'maxLength (compact reply)', name: 'VisionOrnamentReply',
        make: () => { const v = fx.visionReply(); v.elements[1].depthBasis = 'y'.repeat(81); return v; },
        message: 'VisionOrnamentReply.elements[1].depthBasis: is 81 characters long, allows at most 80'
    },
    {
        kind: 'pattern', name: 'StagedBuildState',
        make: () => ({ ...fx.stagedBuildState(), runId: 'A1B2C3D4' }),
        message: 'StagedBuildState.runId: "A1B2C3D4" does not match /^[0-9a-f]{8}$/'
    },
    {
        kind: 'pattern (an artifact id the turn commit would re-key)', name: 'StagedBuildState',
        make: () => ({ ...fx.stagedBuildState(), artifactId: 'artifact-3d-1760540000000' }),
        message: 'StagedBuildState.artifactId: "artifact-3d-1760540000000" does not match /^(?![\\s\\S]*[0-9]{10}$)/'
    },
    {
        kind: 'pattern (layer object id)', name: 'StageEvent',
        make: () => { const v = fx.stageEvent(); v.layers![0].objectId = 'artifact-3d-1760540000000'; return v; },
        message: 'StageEvent.layers[0].objectId: "artifact-3d-1760540000000" does not match /^stg-[0-9a-f]{8}-[a-z0-9]+$/'
    },
    {
        kind: 'pattern (legend colour)', name: 'StagedBuildState',
        make: () => { const v = fx.stagedBuildState(); v.provenanceLegend[0].color = '#07b'; return v; },
        message: 'StagedBuildState.provenanceLegend[0].color: "#07b" does not match /^#[0-9a-fA-F]{6}$/'
    },
    {
        kind: 'oneOf: no alternative fits', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); (v.primitives[0].spec as unknown as { sweep: Record<string, unknown> }).sweep.carrier = { slotId: 'S02' }; return v; },
        message: 'StructureFit.primitives[0].spec.sweep.carrier: matches none of the alternatives; expected {path} or {slot} or {chart}'
    },
    {
        kind: 'oneOf: the meant alternative reports its own problem', name: 'StructureFit',
        make: () => {
            const v = fx.structureFit();
            (v.primitives[1].spec as unknown as { sweep: Record<string, unknown> }).sweep.carrier = { slot: { slotId: 'S02', t0: 1.5, t1: 0.2, offset: [0, 0] } };
            return v;
        },
        message: 'StructureFit.primitives[1].spec.sweep.carrier.slot.t0: 1.5 is above the maximum 1'
    },
    {
        kind: 'oneOf: an unknown operator', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); (v.elements[1].spec as Record<string, unknown>).operator = 'extrude'; return v; },
        message: 'OrnamentSpec.elements[1].spec: matches none of the alternatives; expected {operator: "sweep", sweep} or {operator: "revolve", revolve} or {operator: "relief", relief} or {operator: "replicate", replicate}'
    },
    {
        kind: 'oneOf: more than one alternative', name: 'VisionOrnamentReply',
        make: () => { const v = fx.visionReply(); v.elements[2].op = { replicate: { seed: { relief: { box: [0, 0, 1100, 1100], poly: [0, 0, 1, 0, 1, 1], depth: -120 } }, grid: [300, 300, 1450, 1450, 9, 6, 0] } }; return v; },
        message: 'VisionOrnamentReply.elements[2].op.replicate.seed.relief: matches 2 of the alternatives ({box}, {poly}); exactly one must match'
    },
    {
        kind: 'oneOf: along and grid together', name: 'VisionOrnamentReply',
        make: () => { const v = fx.visionReply(); (v.elements[2].op as { replicate: Record<string, unknown> }).replicate.along = [0, 500, 4]; return v; },
        message: 'VisionOrnamentReply.elements[2].op.replicate: matches 2 of the alternatives ({along}, {grid}); exactly one must match'
    },
    {
        kind: 'oneOf + enum (thinking level)', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); (v.model as unknown as Record<string, unknown>).thinking = { level: 'NONE' }; return v; },
        message: 'OrnamentSpec.model.thinking.level: "NONE" is not one of "LOW", "MEDIUM", "HIGH"'
    },
    {
        kind: 'if/then: anything not measured carries a confidence', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); delete v.elements[0].provenance.confidence; return v; },
        message: 'OrnamentSpec.elements[0].provenance: required property "confidence" is missing (because measuredGeometry is false)'
    },
    {
        kind: 'if/then: photo-inferred is never measured', name: 'StagedNodeExtras',
        make: () => { const v = fx.detailNodeExtras(); v.sb.provenance.measuredGeometry = true; return v; },
        message: 'StagedNodeExtras.sb.provenance.measuredGeometry: must be false, got true (because label is "photo-inferred")'
    },
    {
        kind: 'if/then: a face placed without scan samples is never measured', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); v.surfaces[2].provenance.measuredGeometry = true; delete v.surfaces[2].provenance.confidence; return v; },
        message: 'StructureFit.surfaces[2].provenance.measuredGeometry: must be false, got true (because label is "fitted-unobserved")'
    },
    {
        kind: 'user decision: photo correction tolerance 0.31 m', name: 'StructureFit',
        make: () => { const v = fx.structureFit(); v.primitives[1].correctable[0].toleranceM = 0.5; return v; },
        message: 'StructureFit.primitives[1].correctable[0].toleranceM: 0.5 is above the maximum 0.31'
    },
    {
        kind: 'user decision: a correction checked against 0.31 m', name: 'OrnamentSpec',
        make: () => { const v = fx.ornamentSpec(); v.corrections[0].check.toleranceM = 0.32; return v; },
        message: 'OrnamentSpec.corrections[0].check.toleranceM: 0.32 is above the maximum 0.31'
    },
    {
        kind: 'user decision: at most 16 Street View images per building', name: 'StagedLocationResult',
        make: () => ({
            ...fx.stagedLocationResult(),
            ornament: {
                elements: 3, slotsFilled: 3, slotsEmpty: 1, confidence: { min: 0.48, median: 0.62, max: 0.81 },
                evidence: { tileOrthos: 1, streetView: MAX_STREET_VIEW_IMAGES_PER_BUILDING + 1 }, model: fx.visionModelUse(), revisionPass: false, dropped: 1,
                specPath: '.scratchbox/cache/staged_location/ornament/ornament_spec.json'
            }
        }),
        message: 'StagedLocationResult.ornament.evidence.streetView: 17 is above the maximum 16'
    }
];

describe('validateContract: each kind of invalid example fails with a precise message', () => {
    it.each(INVALID.map(c => [c.kind, c] as const))('%s', (_kind, c) => {
        const messages = validateContract(c.name, c.make());
        outcomes.push({ group: 'invalid', title: c.kind, contract: c.name, messages });
        expect(messages).toEqual([c.message]);
    });

    it('names an unknown contract and lists the known ones', () => {
        const messages = validateContract('Nope' as StagedSchemaName, {});
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/^unknown contract "Nope"; known: vec2, vec3, .*StagedLocationResult$/);
    });

    it('reports every problem in one pass, each with its own path', () => {
        const v = fx.stagedBuildState();
        v.runId = 'nope';
        v.layers[1].reveal.stagger = 1.5;
        v.degradations[0].transient = 'yes' as unknown as boolean;
        expect(validateContract('StagedBuildState', v)).toEqual([
            'StagedBuildState.runId: "nope" does not match /^[0-9a-f]{8}$/',
            'StagedBuildState.layers[1].reveal.stagger: 1.5 is above the maximum 1',
            'StagedBuildState.degradations[0].transient: expected boolean, got string "yes"'
        ]);
    });

    it('caps a flood of problems at 100 messages with a count of the rest', () => {
        const reply = fx.visionReply();
        reply.emptySlots = Array.from({ length: 150 }, (_, i) => ({ slot: `S${i}`, why: 'z'.repeat(81) }));
        const messages = validateContract('VisionOrnamentReply', reply);
        expect(messages).toHaveLength(101);
        expect(messages[100]).toBe('… and 50 more problems');
    });
});

describe('user decisions', () => {
    const rung = (stage: string, reasonCode: string) => STAGED_DEGRADE_LADDER.find(r => r.stage === stage && r.reasonCode === reasonCode);

    it('degrades instead of fabricating: hard failure only where there is no real data', () => {
        expect(STAGED_DEGRADE_LADDER.filter(r => r.fellTo === null).map(r => r.reasonCode)).toEqual(['place_unresolved', 'no_tile_coverage']);
        expect(STAGED_DEGRADE_LADDER.filter(r => r.fellTo === null).every(r => r.provenanceAfter === null)).toBe(true);
    });

    it('drops each failing part one rung to the same real data', () => {
        expect(rung('vision', 'vision_unavailable')).toMatchObject({ fellTo: 'the flat fitted face', provenanceAfter: 'fitted' });
        expect(rung('detail', 'detail_failed')).toMatchObject({ fellTo: 'the flat fitted face', provenanceAfter: 'fitted' });
        expect(rung('fit', 'fit_rejected')).toMatchObject({ fellTo: 'the remeshed scan', provenanceAfter: 'remeshed' });
        expect(rung('remesh', 'remesh_failed')?.provenanceAfter).toBe('scan-flattened');
        expect(rung('remesh', 'remesh_failed')?.fellTo).toMatch(/raw scan with its facades flattened/);
        expect(rung('trees', 'not_regrowable')).toMatchObject({ fellTo: 'that tree kept as scanned', provenanceAfter: 'as-scanned' });
    });

    it('puts the scanned trees back, labelled as scanned, when the tree stage fails (never "no trees")', () => {
        const trees = STAGED_DEGRADE_LADDER.filter(r => r.stage === 'trees');
        expect(rung('trees', 'trees_failed')).toMatchObject({ fellTo: 'the scanned trees put back', provenanceAfter: PROVENANCE.asScanned });
        for (const r of trees) expect(r.fellTo ?? '').not.toMatch(/no trees|without trees/i);
        expect(validateContract('DegradationRecord', fx.treesDegradation())).toEqual([]);
        expect(fx.layers().find(l => l.layer === 'l5x')?.provenance.label).toBe(PROVENANCE.asScanned);
    });

    it('makes a valid, shaded DegradationRecord from every rung that degrades', () => {
        const legend = new Set(DEFAULT_PROVENANCE_LEGEND.map(e => e.label));
        for (const r of STAGED_DEGRADE_LADDER.filter(x => x.fellTo !== null)) {
            const record: DegradationRecord = {
                id: `d-${r.stage}-${r.reasonCode}`, stage: r.stage, part: { description: r.failure }, intended: 'the stage output',
                fellTo: r.fellTo!, provenanceAfter: r.provenanceAfter!, reasonCode: r.reasonCode, reason: `${r.failure}; showing ${r.fellTo}.`,
                transient: false, atMs: 0
            };
            expect(validateContract('DegradationRecord', record), r.reasonCode).toEqual([]);
            expect(legend.has(r.provenanceAfter!), `${r.reasonCode} → ${r.provenanceAfter}`).toBe(true);
        }
    });

    it('labels trees "grown to the measured crown", photo detail photo-inferred and corrections photo-corrected', () => {
        expect(PROVENANCE.grownToMeasuredCrown).toBe('grown to the measured crown');
        expect(PROVENANCE.photoInferred).toBe('photo-inferred');
        expect(PROVENANCE.photoCorrected).toBe('photo-corrected');
        const labels = DEFAULT_PROVENANCE_LEGEND.map(e => e.label);
        expect(new Set(labels).size).toBe(labels.length);
        expect([...labels].sort()).toEqual(Object.values(PROVENANCE).sort());
        // AGENTS.md: only geometry fitted to a scan, or measured from calibrated photos, may be labelled measured
        expect(labels).not.toContain('measured');
        expect(NON_MEASURED_PROVENANCE_LABELS).toEqual(['photo-inferred', 'photo-corrected', 'fitted-unobserved']);
        for (const e of DEFAULT_PROVENANCE_LEGEND) expect(e.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(validateContract('StagedNodeExtras', fx.treeNodeExtras())).toEqual([]);
    });

    it('reads detail with gemini-4-argon at thinking LOW, chosen without a benchmark, and records any fallback', () => {
        expect(STAGED_VISION_MODEL_DEFAULT).toEqual({ model: 'gemini-4-argon', thinking: { level: 'LOW' }, selection: expect.stringMatching(/without a benchmark/) });
        const fallback = { ...fx.visionModelUse(), used: 'gemini-3.8-flash', answered: 'gemini-3.8-flash-002', skipped: [{ model: 'gemini-4-argon', reason: '404 model not found' }] };
        expect(validateContract('visionModelUse', fallback)).toEqual([]);
        expect(validateContract('visionModelUse', { ...fallback, skipped: [{ model: 'gemini-4-argon' }] }))
            .toEqual(['visionModelUse.skipped[0]: required property "reason" is missing']);
    });

    it('keeps tile_refine relief on, 16 Street View images and a 0.31 m correction tolerance', () => {
        expect(TILE_REFINE_RELIEF_DEFAULT).toBe(true);
        expect(MAX_STREET_VIEW_IMAGES_PER_BUILDING).toBe(16);
        expect(PHOTO_CORRECTION_TOLERANCE_M).toBe(0.31);
        const atLimit = fx.ornamentSpec();
        atLimit.corrections[0].check.toleranceM = 0.31;
        expect(validateContract('OrnamentSpec', atLimit)).toEqual([]);
    });

    it('keeps the summary limits in step with the schema', () => {
        const result = STAGED_LOCATION_SCHEMA.definitions.StagedLocationResult.properties!;
        expect(result.digest.maxLength).toBe(STAGED_SUMMARY_LIMITS.digestMaxChars);
        expect(STAGED_SUMMARY_LIMITS).toEqual({ digestMaxChars: 200, contextLineMaxChars: 1500, degradedPartsWrittenOut: 5 });
        expect(new Set(STAGED_SUMMARY_RULES.map(r => r.id)).size).toBe(STAGED_SUMMARY_RULES.length);
        expect(STAGED_SUMMARY_RULES.find(r => r.id === 'trees')?.rule).toMatch(/grown to the measured crown/);
        expect(STAGED_SUMMARY_RULES.find(r => r.id === 'trees')?.rule).toMatch(/scanned trees were put back/);
        expect(PHOTO_INFERRED_FORBIDDEN_WORDS).toEqual(['measured', 'accurate', 'real']);
        expect(fx.stagedLocationResult().digest.startsWith('Staged build degraded:')).toBe(true);
    });

    it('decides the scan_fit negative cache by code, treating timeouts, aborts and builds as transient', () => {
        expect(Object.entries(SCAN_FIT_ERROR_TRANSIENT).filter(([, t]) => t).map(([c]) => c).sort()).toEqual(['aborted', 'build_failed', 'timeout']);
    });
});

describe("tile_refine's per-vertex provenance, in bands", () => {
    it('names the attributes tile_refine writes', () => {
        expect(TILE_REFINE_VERTEX_ATTRIBUTES).toEqual({ rectifyDisplacement: '_RECTIFY_DISPLACEMENT', proudBlock: '_PROUD_BLOCK', reliefHeight: '_RELIEF_HEIGHT' });
    });

    it('bands the displacement contiguously from 0: untouched < 1 cm, moved 1–5 cm, reshaped > 5 cm', () => {
        expect(RECTIFY_DISPLACEMENT_BANDS.map(b => [b.band, b.minM, b.maxM])).toEqual([['untouched', 0, 0.01], ['moved', 0.01, 0.05], ['reshaped', 0.05, undefined]]);
        const band = (m: number) => classifyRemeshVertex({ rectifyDisplacementM: m }).band;
        // the seam solve nudges sub-millimetre: a band, not an exact-zero test
        expect([0, 0.0004, 0.0099].map(band)).toEqual(['untouched', 'untouched', 'untouched']);
        expect([0.01, 0.0499].map(band)).toEqual(['moved', 'moved']);
        expect([0.05, 0.433].map(band)).toEqual(['reshaped', 'reshaped']);
        // every band is still the remeshed surface: an untouched vertex is not "as scanned"
        expect(classifyRemeshVertex({ rectifyDisplacementM: 0 }).label).toBe('remeshed');
    });

    it('reads proud-block codes in bands around 1 and 2', () => {
        expect(PROUD_BLOCK_BANDS.map(b => [b.minM, b.maxM])).toEqual([[0.5, 1.5], [1.5, 2.5]]);
        expect(classifyRemeshVertex({ proudBlock: 1, rectifyDisplacementM: 0.002 })).toEqual({ label: 'as-scanned', band: 'block-kept-as-scanned' });
        expect(classifyRemeshVertex({ proudBlock: 0.9999 })).toEqual({ label: 'as-scanned', band: 'block-kept-as-scanned' });
        expect(classifyRemeshVertex({ proudBlock: 2, rectifyDisplacementM: 0.08 })).toEqual({ label: 'remeshed', band: 'block-snapped' });
        // 0 = not a block: the displacement decides
        expect(classifyRemeshVertex({ proudBlock: 0, rectifyDisplacementM: 0.03 })).toEqual({ label: 'remeshed', band: 'moved' });
    });

    it('shades a vertex carved by photo relief photo-inferred, above 1 mm either way', () => {
        expect(RELIEF_HEIGHT_CARVED_MIN_M).toBe(0.001);
        expect(classifyRemeshVertex({ reliefHeightM: -0.03, proudBlock: 1, rectifyDisplacementM: 0 })).toEqual({ label: 'photo-inferred', band: 'relief-inferred' });
        expect(classifyRemeshVertex({ reliefHeightM: 0.001 }).label).toBe('photo-inferred');
        expect(classifyRemeshVertex({ reliefHeightM: 0.0005, rectifyDisplacementM: 0.0005 })).toEqual({ label: 'remeshed', band: 'untouched' });
    });

    it('treats an absent attribute as no per-vertex claim, never as "as scanned"', () => {
        expect(classifyRemeshVertex({})).toEqual({ label: 'remeshed', band: 'no-per-vertex-claim' });
        expect(classifyRemeshVertex({}, 'scan-flattened')).toEqual({ label: 'scan-flattened', band: 'no-per-vertex-claim' });
        expect(classifyRemeshVertex({ rectifyDisplacementM: NaN })).toEqual({ label: 'remeshed', band: 'no-per-vertex-claim' });
    });

    it('carries the per-run band counts on the remesh layer and in the result', () => {
        expect(validateContract('vertexProvenance', fx.vertexProvenance())).toEqual([]);
        const layer = fx.layers().find(l => l.layer === 'l2')!;
        expect(layer.vertexProvenance?.rectifyDisplacement?.bands.map(b => b.band)).toEqual(RECTIFY_DISPLACEMENT_BANDS.map(b => b.band));
        const bad = { ...fx.vertexProvenance(), relief: { carvedVertices: -1, maxAbsHeightM: 0.12 } };
        expect(validateContract('vertexProvenance', bad)).toEqual(['vertexProvenance.relief.carvedVertices: -1 is below the minimum 0']);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Screenshot of the outcome table
// ---------------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function outcomeHtml(): string {
    const valid = outcomes.filter(o => o.group === 'valid');
    const invalid = outcomes.filter(o => o.group === 'invalid');
    const legend = DEFAULT_PROVENANCE_LEGEND.map(e => `<div class="sw"><span style="background:${e.color}"></span>${esc(String(e.label))} <i>${esc(String(e.pattern))}</i></div>`).join('');
    const ladder = STAGED_DEGRADE_LADDER.map(r => `<tr><td>${esc(r.stage)}</td><td>${esc(r.failure)}</td><td>${r.fellTo ? esc(r.fellTo) : '<b>hard failure</b>'}</td><td>${esc(String(r.provenanceAfter ?? '—'))}</td></tr>`).join('');
    return `<style>
        .page { padding: 14px 18px; font-size: 11px; line-height: 1.35; color: #e4e4e7; background: ${PROVENANCE_BACKGROUND}; height: 100%; box-sizing: border-box; }
        h1 { font-size: 15px; margin: 0 0 6px; } h2 { font-size: 12px; margin: 10px 0 4px; color: #a1a1aa; }
        table { border-collapse: collapse; width: 100%; } td { padding: 1px 6px; vertical-align: top; border-bottom: 1px solid #2c323b; }
        .ok { color: #4ade80; } .bad { color: #f87171; } code { color: #fde68a; font-size: 10.5px; }
        .sw { display: inline-block; margin: 0 12px 4px 0; } .sw span { display: inline-block; width: 12px; height: 12px; vertical-align: -2px; margin-right: 4px; border-radius: 2px; }
        .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    </style><div class="page">
        <h1>Staged location contracts: ${valid.filter(o => o.messages.length === 0).length}/${valid.length} valid examples pass, ${invalid.filter(o => o.messages.length === 1).length}/${invalid.length} invalid examples fail with one precise message</h1>
        <h2>Valid examples</h2>
        <div>${valid.map(o => `<span class="${o.messages.length ? 'bad' : 'ok'}">${o.messages.length ? '✕' : '✓'} ${esc(o.contract)}</span>`).join(' &nbsp; ')}</div>
        <h2>Invalid examples (kind → message)</h2>
        <table>${invalid.map(o => `<tr><td class="${o.messages.length === 1 ? 'ok' : 'bad'}">${o.messages.length === 1 ? '✓' : '✕'}</td><td>${esc(o.title)}</td><td><code>${esc(o.messages.join(' | '))}</code></td></tr>`).join('')}</table>
        <div class="cols"><div>
            <h2>Degrade ladder (same real data, one rung down)</h2><table>${ladder}</table>
        </div><div>
            <h2>Default provenance legend on ${PROVENANCE_BACKGROUND}</h2>${legend}
            <h2>tile_refine per-vertex bands</h2>
            <table>${RECTIFY_DISPLACEMENT_BANDS.map(b => `<tr><td>${esc(b.band)}</td><td>${b.minM}–${b.maxM ?? '∞'} m</td><td>${esc(b.description)}</td></tr>`).join('')}
            ${PROUD_BLOCK_BANDS.map(b => `<tr><td>${esc(b.band)}</td><td>code ${b.minM}–${b.maxM}</td><td>${esc(String(b.label))}</td></tr>`).join('')}
            <tr><td>relief-inferred</td><td>|h| ≥ ${RELIEF_HEIGHT_CARVED_MIN_M} m</td><td>photo-inferred</td></tr></table>
        </div></div>
    </div>`;
}

/** The decompressed scanlines of a PNG, to check the screenshot is not a blank frame. */
function pngPixels(png: Buffer): { width: number; height: number; data: Buffer } {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const parts: Buffer[] = [];
    for (let o = 8; o < png.length;) {
        const len = png.readUInt32BE(o), type = png.toString('latin1', o + 4, o + 8);
        if (type === 'IDAT') parts.push(png.subarray(o + 8, o + 8 + len));
        o += 12 + len;
    }
    return { width, height, data: zlib.inflateSync(Buffer.concat(parts)) };
}

describe('outcome screenshot', () => {
    it.skipIf(!htmlScreenshotChrome.ok)(`renders the outcome table to test-results/screenshots/staged${htmlScreenshotChrome.ok ? '' : ` [skipped: ${htmlScreenshotChrome.reason}]`}`, async () => {
        expect(outcomes.length).toBe(fx.validExamples().length + INVALID.length);
        const shot = await saveHtmlScreenshot('staged_contracts_validation_tmp', outcomeHtml(), { width: 1280, height: 1720, background: PROVENANCE_BACKGROUND });
        const dir = path.join(REPO_ROOT, 'test-results', 'screenshots', 'staged');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, 'contracts_validation.png');
        fs.renameSync(shot.path, out);
        const png = fs.readFileSync(out);
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const { width, height, data } = pngPixels(png);
        expect(width).toBeGreaterThanOrEqual(1280);
        expect(height).toBeGreaterThanOrEqual(1720);
        // text, swatches and table rules: far more than a blank or single-colour frame
        expect(new Set(data).size).toBeGreaterThan(64);
    });
});
