/**
 * Separated entities carry measured shape descriptors, and routing reads those numbers, not the entity's label.
 * Labels are open strings for people reading a report: a shape nobody named still routes by what was measured.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  Universal3DObjectSeparationService,
  measureShapeDescriptors,
  routeFromDescriptors,
  isBroadLowSurface,
  type SpatialEntityLabel
} from '../src/node/spatial/Universal3DObjectSeparationService';
import { REPO_ROOT } from './helpers/requirements';

const MODEL = { min: [0, 0, 0] as const, max: [100, 60, 100] as const };

/** Points on a regular grid over [x0,x1] x [y0,y1] x [z0,z1] (a degenerate axis gives a sheet). */
function grid(x: [number, number], y: [number, number], z: [number, number], n = 12): [number, number, number][] {
  const out: [number, number, number][] = [];
  const at = (r: [number, number], i: number) => r[0] + (r[1] - r[0]) * (i / (n - 1));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    if (x[0] === x[1] && i > 0 || y[0] === y[1] && j > 0 || z[0] === z[1] && k > 0) continue;
    out.push([at(x, i), at(y, j), at(z, k)]);
  }
  return out;
}

describe('measured shape descriptors drive separation routing', () => {
  it('a broad flat sheet at the bottom measures as a horizontal plane and routes to terrain', () => {
    const d = measureShapeDescriptors(grid([0, 100], [0, 0.5], [0, 80]), [100, 0.5, 80], MODEL, 1);
    expect(d.heightMeters).toBeCloseTo(0.5, 5);
    expect(d.footprintAreaM2).toBe(8000);
    expect(d.compactness).toBeCloseTo(0.8, 5);
    expect(d.slenderness).toBeLessThan(0.01);
    expect(d.planarity).toBeGreaterThan(0.5);
    expect(d.verticality).toBeLessThan(0.05);
    expect(d.relativeElevation).toBeLessThan(0.01);
    expect(isBroadLowSurface(d)).toBe(true);
    expect(routeFromDescriptors(d)).toBe('sb-terrain');
  });

  it('a tall square tower and a vertical wall measure as such and route to the building rebuild', () => {
    const tower = measureShapeDescriptors(grid([40, 50], [0, 50], [40, 50]), [10, 50, 10], MODEL, 3);
    expect(tower.slenderness).toBeCloseTo(5, 5);
    expect(tower.compactness).toBeCloseTo(1, 5);
    expect(tower.linearity).toBeGreaterThan(0.8);
    expect(tower.connectedSubmeshCount).toBe(3);
    expect(routeFromDescriptors(tower)).toBe('archie-building');

    const wall = measureShapeDescriptors(grid([0, 60], [0, 20], [30, 30]), [60, 20, 0.01], MODEL, 1);
    expect(wall.verticality).toBeGreaterThan(0.99);
    // A sheet has no spread across it: planarity + linearity = 1 - l3/l1
    expect(wall.planarity + wall.linearity).toBeGreaterThan(0.99);
    expect(routeFromDescriptors(wall)).toBe('archie-building');
  });

  it('a raised flat deck is not ground: the same sheet high in the model routes to the building rebuild', () => {
    const d = measureShapeDescriptors(grid([0, 100], [50, 50.5], [0, 80]), [100, 0.5, 80], MODEL, 1);
    expect(d.baseElevationMeters).toBeCloseTo(50, 5);
    expect(d.relativeElevation).toBeGreaterThan(0.8);
    expect(routeFromDescriptors(d)).toBe('archie-building');
  });

  it('labels are open strings and routing has no label input (a label nobody listed compiles and changes nothing)', () => {
    const label: SpatialEntityLabel = 'bioluminescent methane-geyser vent';
    expect(typeof label).toBe('string');
    expect(routeFromDescriptors.length).toBe(1);
  });

  it('every separated object of a real tile carries descriptors, and submesh routing equals routing from them', async () => {
    const glbPath = path.join(REPO_ROOT, 'deploy/cloud-run/spatial-separator/assets/colosseum_clay.glb');
    expect(fs.existsSync(glbPath)).toBe(true);
    const scene = await new Universal3DObjectSeparationService().separate({ glbPath, granularity: 'macro' });
    expect(scene.objects.length).toBeGreaterThan(0);
    for (const o of scene.objects) {
      expect(o.descriptors.pointCount).toBeGreaterThan(0);
      expect(o.descriptors.heightMeters).toBeCloseTo(o.boundingBox.dimensions[1], 3);
      expect(o.descriptors.connectedSubmeshCount).toBe(o.submeshIndices.length);
      expect(o.routingRecommendation).toBe(routeFromDescriptors(o.descriptors));
    }

    const detailed = await new Universal3DObjectSeparationService().separate({ glbPath, granularity: 'all' });
    for (const o of detailed.objects) {
      expect(o.descriptors).toBeDefined();
      // Residual points are what no stage claimed; nothing says what they are
      expect(o.trellisPrompt).not.toMatch(/bollard|street furniture|curb|pedestrian/i);
    }
  }, 120_000);
});
