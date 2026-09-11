import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import {
    createArticulatedAircraft,
    createAirplaneMesh,
    updateFlightPhysics
} from '../src/browser/generative-canvas/services/mesh/aircraft';
import {
    AIRCRAFT_HELPERS_SOURCE,
    FLIGHT_PHYSICS_SOURCE
} from '../src/browser/generative-canvas/services/mesh/aircraft-template';
import * as Scene3D from '../src/browser/generative-canvas/primitives/Scene3DPrimitive';
import { morphScene3DToSandbox } from '../src/browser/generative-canvas/primitive-transformer-engine';
import { slugify } from '../src/browser/generative-canvas/services/text-utils';

const GC_DIR = path.resolve(__dirname, '../src/browser/generative-canvas');

async function runAircraftDedupeTests() {
    console.log('🧪 Running Aircraft Helpers Dedupe Test Suite...\n');

    // -------------------------------------------------------------
    // Test 1: Real implementation lives in services/mesh/aircraft.ts and Scene3D re-exports it
    // -------------------------------------------------------------
    console.log('  Testing single implementation site...');
    const primitiveSource = fs.readFileSync(path.join(GC_DIR, 'primitives/Scene3DPrimitive.tsx'), 'utf-8');
    const engineSource = fs.readFileSync(path.join(GC_DIR, 'primitive-transformer-engine.ts'), 'utf-8');
    assert.ok(!/export const createArticulatedAircraft = \(/.test(primitiveSource), 'Scene3DPrimitive must not define createArticulatedAircraft inline');
    assert.ok(!/export const updateFlightPhysics = \(/.test(primitiveSource), 'Scene3DPrimitive must not define updateFlightPhysics inline');
    assert.ok(!/^export function createArticulatedAircraft\(\)/m.test(engineSource), 'Transformer engine must not hand-copy createArticulatedAircraft');
    assert.ok(!/^export function updateFlightPhysics\(/m.test(engineSource), 'Transformer engine must not hand-copy updateFlightPhysics');
    assert.ok(/from '\.\/services\/mesh\/aircraft-template'/.test(engineSource), 'Transformer engine must import the aircraft template source');
    assert.strictEqual(Scene3D.createArticulatedAircraft, createArticulatedAircraft, 'Scene3D must re-export the service implementation');
    assert.strictEqual(Scene3D.updateFlightPhysics, updateFlightPhysics);
    assert.strictEqual(Scene3D.createAirplaneMesh, createAirplaneMesh);
    console.log('  ✓ Test 1 Passed: aircraft helpers have a single implementation.');

    // -------------------------------------------------------------
    // Test 2: Template source mirrors the implementation's function names & signatures
    // -------------------------------------------------------------
    console.log('  Testing template/implementation parity...');
    const implSource = fs.readFileSync(path.join(GC_DIR, 'services/mesh/aircraft.ts'), 'utf-8');
    for (const fnName of ['createAirplaneMesh', 'createArticulatedAircraft']) {
        assert.ok(implSource.includes(`export const ${fnName} = (`) || implSource.includes(`export function ${fnName}(`), `Implementation must define ${fnName}`);
        assert.ok(AIRCRAFT_HELPERS_SOURCE.includes(`export function ${fnName}(`), `Template must define ${fnName}`);
    }
    assert.ok(implSource.includes('export interface ArticulatedAircraftComponents'), 'Implementation must export ArticulatedAircraftComponents');
    assert.ok(AIRCRAFT_HELPERS_SOURCE.includes('export interface ArticulatedAircraftComponents'), 'Template must declare ArticulatedAircraftComponents');

    // Interface fields must match between template and implementation
    const extractInterfaceFields = (src: string): string[] => {
        const m = src.match(/export interface ArticulatedAircraftComponents \{([\s\S]*?)\}/);
        assert.ok(m, 'ArticulatedAircraftComponents interface must be found');
        return m![1].split('\n').map(l => l.trim()).filter(Boolean).map(l => l.replace(/;$/, ''));
    };
    assert.deepStrictEqual(extractInterfaceFields(AIRCRAFT_HELPERS_SOURCE), extractInterfaceFields(implSource), 'Template interface fields must match implementation');

    // updateFlightPhysics signature lines must match
    const sigLines = ['aircraft: THREE.Group,', 'time: number,', 'delta: number,', 'options: { bankScale?: number; pitchScale?: number } = {}'];
    for (const line of sigLines) {
        assert.ok(FLIGHT_PHYSICS_SOURCE.includes(line), `Physics template must contain signature line "${line}"`);
        assert.ok(implSource.includes(line), `Implementation must contain signature line "${line}"`);
    }
    assert.ok(FLIGHT_PHYSICS_SOURCE.includes('export function updateFlightPhysics('), 'Physics template must export updateFlightPhysics');
    console.log('  ✓ Test 2 Passed: template mirrors implementation names and signatures.');

    // -------------------------------------------------------------
    // Test 3: Sandbox morph still ships aircraft.ts / physics.ts from the template constants
    // -------------------------------------------------------------
    console.log('  Testing sandbox morph output...');
    const sandbox = morphScene3DToSandbox({ title: 'Jet Test', objects: [] } as any);
    const aircraftFile = sandbox.files.find(f => f.name === 'aircraft.ts');
    const physicsFile = sandbox.files.find(f => f.name === 'physics.ts');
    assert.ok(aircraftFile && aircraftFile.content === AIRCRAFT_HELPERS_SOURCE, 'aircraft.ts must be emitted from AIRCRAFT_HELPERS_SOURCE');
    assert.ok(physicsFile && physicsFile.content === FLIGHT_PHYSICS_SOURCE, 'physics.ts must be emitted from FLIGHT_PHYSICS_SOURCE');
    console.log('  ✓ Test 3 Passed: sandbox morph uses shared template constants.');

    // -------------------------------------------------------------
    // Test 4: Runtime behaviour of the moved implementation
    // -------------------------------------------------------------
    console.log('  Testing moved implementation runtime...');
    const aircraft = createArticulatedAircraft();
    assert.ok(aircraft.group instanceof THREE.Group);
    assert.strictEqual(aircraft.turbines.length, 2);
    assert.strictEqual(aircraft.thrusters.length, 2);
    const before = aircraft.leftAileron.rotation.x;
    updateFlightPhysics(aircraft.group, 1.5, 0.016);
    assert.notStrictEqual(aircraft.leftAileron.rotation.x, before);
    assert.ok(createAirplaneMesh().children.length >= 6);
    console.log('  ✓ Test 4 Passed: moved aircraft implementation behaves.');

    // -------------------------------------------------------------
    // Test 5: slugify has a single home and the sky dome wrapper is gone
    // -------------------------------------------------------------
    console.log('  Testing slugify + sky dome dedupe...');
    const kanbanLensSource = fs.readFileSync(path.join(GC_DIR, 'lenses/KanbanTaskLens.ts'), 'utf-8');
    assert.ok(!/^function slugify\(/m.test(engineSource), 'primitive-transformer-engine must not define slugify locally');
    assert.ok(!/^function slugify\(/m.test(kanbanLensSource), 'KanbanTaskLens must not define slugify locally');
    assert.ok(/services\/text-utils'/.test(engineSource) && /services\/text-utils'/.test(kanbanLensSource), 'Both must import slugify from services/text-utils');
    assert.strictEqual(slugify('Hello, World!'), 'hello-world');
    assert.strictEqual(slugify('***'), 'item');
    assert.ok(!/export const createAtmosphericSkyDome = \(/.test(primitiveSource), 'Scene3DPrimitive must not wrap createAtmosphericSkyDome');
    assert.ok(typeof Scene3D.createAtmosphericSkyDome === 'function', 'Scene3DPrimitive must still export createAtmosphericSkyDome (service re-export)');
    console.log('  ✓ Test 5 Passed: slugify and sky dome deduped.');

    // -------------------------------------------------------------
    // Test 6: google-maps-service real file lives under services/
    // -------------------------------------------------------------
    console.log('  Testing google-maps-service location...');
    const servicesGm = fs.readFileSync(path.join(GC_DIR, 'services/google-maps-service.ts'), 'utf-8');
    assert.ok(/export class GoogleMapsService/.test(servicesGm), 'services/google-maps-service.ts must contain the real implementation');
    const rootGmPath = path.join(GC_DIR, 'google-maps-service.ts');
    if (fs.existsSync(rootGmPath)) {
        const rootGm = fs.readFileSync(rootGmPath, 'utf-8');
        assert.ok(!/export class GoogleMapsService/.test(rootGm), 'Root google-maps-service.ts may only be a thin re-export');
    }
    for (const f of ['services/Google3DTileService.ts', 'services/GooglePhotorealistic3DTilesLayer.ts']) {
        const src = fs.readFileSync(path.join(GC_DIR, f), 'utf-8');
        assert.ok(/from '\.\/google-maps-service'/.test(src), `${f} must import google-maps-service from services/`);
    }
    console.log('  ✓ Test 6 Passed: google-maps-service relocated.');

    console.log('\n🎉 ALL AIRCRAFT HELPERS DEDUPE TESTS PASSED SUCCESSFULLY!');
}

test('aircraft-helpers-dedupe.test', async () => {
    await runAircraftDedupeTests();
}, 60_000);
