/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ObjectBuildSpec contract: the validator reports every problem (never repairs), the JSON schema is the subset
 * Gemini structured output accepts, and the build script embeds the spec so no value can break out of it.
 */

import { describe, it, expect } from 'vitest';
import {
    OBJECT_BUILD_SPEC_JSON_SCHEMA,
    buildObjectSpecScript,
    countInstances,
    toPythonLiteral,
    validateObjectBuildSpec,
    type ObjectBuildSpec
} from '../src/common/spatial/object-build-spec';

const revolve = (over: Record<string, unknown> = {}) => ({
    axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], meridian: [[0, 0], [0, 0.2], [1, 0.2], [1, 0]],
    smoothing: 0, lobeCount: 0, lobeDepthRatio: 0, helixPitchMeters: 0, ...over
});
const sweep = (over: Record<string, unknown> = {}) => ({
    controlPoints: [[0, 0, 0], [0.5, -0.5, 0]], closedLoop: false, smoothing: 0.5,
    profile: [{ t: 0, widthMeters: 0.05, heightMeters: 0.05, exponent: 2 }], ...over
});

function baseSpec(): ObjectBuildSpec {
    return {
        subject: 'lamp',
        observations: ['a column on a base'],
        boundingMeters: [1, 1.2, 1],
        expectedBodies: 1,
        parts: [
            { id: 'body', label: 'body', revolve: revolve() as any },
            { id: 'arm', label: 'arm', parentId: 'body', attach: { u: 0.5, angleDeg: 90, normalOffsetMeters: -0.01 }, sweep: sweep() as any },
            { id: 'arms', label: 'arms', replicate: { seedPartId: 'arm', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 4, spanDeg: 360, risePerCopyMeters: 0 } } },
            { id: 'rings', label: 'rings', relief: { targetPartId: 'body', curves: [[[0.3, 0], [0.3, 1]]], widthMeters: 0.02, depthMeters: -0.005, sharpness: 0.5 } }
        ]
    };
}

function withPart(mutate: (spec: any) => void): unknown {
    const spec: any = JSON.parse(JSON.stringify(baseSpec()));
    mutate(spec);
    return spec;
}

describe('validateObjectBuildSpec', () => {
    it('accepts a spec using all four operators', () => {
        expect(validateObjectBuildSpec(baseSpec())).toEqual([]);
        expect(countInstances(baseSpec())).toBe(1 + 4);
    });

    it('rejects a missing or unknown parent', () => {
        const errors = validateObjectBuildSpec(withPart(s => { s.parts[1].parentId = 'nope'; }));
        expect(errors.join('\n')).toContain('parentId "nope" does not name a part');
    });

    it('rejects parent cycles', () => {
        const errors = validateObjectBuildSpec(withPart(s => {
            s.parts[0].parentId = 'arm';
            s.parts[0].attach = { u: 0.5, angleDeg: 0, normalOffsetMeters: 0 };
            s.parts[0].revolve.axisOrigin = [0, 0, 0];
        }));
        expect(errors.join('\n')).toMatch(/parentId chain forms a cycle/);
    });

    it('rejects non-finite numbers (NaN, Infinity)', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].revolve.meridian[1][1] = NaN; })).join('\n'))
            .toContain('revolve.meridian must be 2-64 [axial, radius] points');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[1].attach.u = Infinity; })).join('\n'))
            .toContain('attach.u must be between 0 and 1');
    });

    it('rejects negative radii and sizes', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].revolve.meridian[1][1] = -0.2; })).join('\n'))
            .toContain('radii must be 0 or more');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[1].sweep.profile[0].widthMeters = -0.05; })).join('\n'))
            .toContain('widthMeters must be greater than 0');
    });

    it('rejects a part with no operator, or with two', () => {
        expect(validateObjectBuildSpec(withPart(s => { delete s.parts[0].revolve; })).join('\n'))
            .toContain('must have exactly one of sweep, revolve, replicate, relief (found none)');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].sweep = sweep(); })).join('\n'))
            .toContain('(found sweep, revolve)');
    });

    it('treats null operator blocks as absent', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].sweep = null; s.parts[0].relief = null; }))).toEqual([]);
    });

    it('keeps children attached by construction', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[1].sweep.controlPoints[0] = [0.1, 0, 0]; })).join('\n'))
            .toContain('controlPoints[0] must be [0, 0, 0]');
        expect(validateObjectBuildSpec(withPart(s => { delete s.parts[1].attach; })).join('\n'))
            .toContain('attach {u, angleDeg, normalOffsetMeters} is required with parentId');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].attach = { u: 0, angleDeg: 0, normalOffsetMeters: 0 }; })).join('\n'))
            .toContain('attach is given without parentId');
        const child = withPart(s => {
            s.parts.push({ id: 'knob', label: 'knob', parentId: 'body', attach: { u: 1, angleDeg: 0, normalOffsetMeters: 0 }, revolve: revolve({ meridian: [[0.1, 0], [0.1, 0.05], [0.2, 0]] }) });
        });
        expect(validateObjectBuildSpec(child).join('\n')).toContain("meridian's axial distances must span 0");
    });

    it('allows replicate and relief only on parts with geometry', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[3].relief.targetPartId = 'arms'; })).join('\n'))
            .toContain('is a replicate part; relief needs a sweep or revolve surface');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[2].replicate.seedPartId = 'rings'; })).join('\n'))
            .toContain('is a relief part, which has no geometry to copy');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[2].parentId = 'body'; s.parts[2].attach = { u: 0, angleDeg: 0, normalOffsetMeters: 0 }; })).join('\n'))
            .toContain('cannot attach to a parent');
        expect(validateObjectBuildSpec(withPart(s => { s.parts[2].replicate.path = { points: [[0, 0, 0], [1, 0, 0]], count: 3, orientToPath: false }; })).join('\n'))
            .toContain('replicate needs exactly one of ring or path');
    });

    it('rejects replicate seed cycles and a seed copied twice', () => {
        const errors = validateObjectBuildSpec(withPart(s => {
            s.parts.push({ id: 'more', label: 'more', replicate: { seedPartId: 'arm', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 2, spanDeg: 180, risePerCopyMeters: 0 } } });
        }));
        expect(errors.join('\n')).toContain('is already copied by "arms"');
        const loop = validateObjectBuildSpec(withPart(s => {
            s.parts[2].replicate.seedPartId = 'loop';
            s.parts.push({ id: 'loop', label: 'loop', replicate: { seedPartId: 'arms', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 2, spanDeg: 180, risePerCopyMeters: 0 } } });
        }));
        expect(loop.join('\n')).toContain('replicate seeds form a cycle');
    });

    it('catches unit mistakes and oversized instance counts', () => {
        expect(validateObjectBuildSpec(withPart(s => { s.parts[0].revolve.axisOrigin = [0, 120, 0]; })).join('\n'))
            .toContain('lies far outside boundingMeters; coordinates are metres');
        const heavy = withPart(s => {
            s.parts[2].replicate.ring.count = 256;
            s.parts.push({ id: 'arms2', label: 'more', mirrorPlaneNormal: [1, 0, 0], replicate: { seedPartId: 'arms', ring: { centerMeters: [0, 0, 0], axisDirection: [0, 1, 0], count: 16, spanDeg: 360, risePerCopyMeters: 0.01 } } });
        });
        expect(validateObjectBuildSpec(heavy).join('\n')).toMatch(/emits \d+ part instances/);
    });

    it('reports every problem at once', () => {
        const errors = validateObjectBuildSpec({ subject: '', observations: 'x', boundingMeters: [0, 1], expectedBodies: 0, parts: [] });
        expect(errors.length).toBeGreaterThanOrEqual(5);
    });
});

describe('OBJECT_BUILD_SPEC_JSON_SCHEMA', () => {
    it('uses only keywords Gemini structured output accepts on Vertex', () => {
        // prefixItems is documented for the Gemini API but Vertex refused a schema using it (400 INVALID_ARGUMENT).
        const allowed = new Set(['type', 'format', 'title', 'description', 'enum', 'items', 'minItems', 'maxItems',
            'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering']);
        const walk = (node: any): void => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return;
            for (const [key, value] of Object.entries(node)) {
                expect(allowed.has(key), `unsupported schema keyword ${key}`).toBe(true);
                if (key === 'properties') Object.values(value as object).forEach(walk);
                else if (key === 'items') walk(value);
            }
            // Every array names its items.
            if (node.type === 'array') expect(node.items, JSON.stringify(node).slice(0, 120)).toBeDefined();
        };
        walk(OBJECT_BUILD_SPEC_JSON_SCHEMA);
        const part = (OBJECT_BUILD_SPEC_JSON_SCHEMA as any).properties.parts.items;
        expect(Object.keys(part.properties)).toEqual(expect.arrayContaining(['sweep', 'revolve', 'replicate', 'relief', 'attach', 'parentId']));
        expect((OBJECT_BUILD_SPEC_JSON_SCHEMA as any).properties.boundingMeters).toMatchObject({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 });
    });
});

describe('build script', () => {
    it('writes the spec as an editable Python literal no value can break out of', () => {
        const spec = baseSpec();
        spec.subject = 'tricky """ label \\ with "quotes"\n and a newline';
        spec.parts[0].label = "'''); import os; os.system('x') #";
        const script = buildObjectSpecScript(spec);
        expect(script).toContain('import scratchbox as sb');
        expect(script).toContain('sb.io.write_glb(OUTPUT_GLB_PATH, sb.object_spec.build(SPEC))');
        expect(script).toContain('"lobeCount": 0');
        expect(script).toContain('"closedLoop": False');
        // Strings are JSON string literals: quotes and backslashes are escaped, so the literal never ends early.
        expect(script).toContain(JSON.stringify(spec.subject));
        expect(toPythonLiteral(null)).toBe('None');
        expect(() => toPythonLiteral(NaN)).toThrow();
    });
});
