import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Colosseum Universal Multi-Modal Object Inversion (410 Objects)', () => {
  const assetsDir = path.resolve(__dirname, '../../../deploy/cloud-run/spatial-separator/assets');
  const totalEntitiesPath = path.join(assetsDir, 'total_entities.json');

  it('should load all 410 entities from total_entities.json, with no generated trees', () => {
    expect(fs.existsSync(totalEntitiesPath)).toBe(true);
    const entities = JSON.parse(fs.readFileSync(totalEntitiesPath, 'utf8'));
    expect(entities.length).toBe(410);

    const categories: Record<string, number> = {};
    for (const e of entities) {
      categories[e.category] = (categories[e.category] || 0) + 1;
      expect(e.id).toBeDefined();
      expect(e.name).toBeDefined();
      expect(e.orientedBoundingBox || e.boundingBox).toBeDefined();
    }

    expect(categories['colosseum_architecture']).toBe(348);
    // the 1,260 "identified" trees came from a seeded random generator, not the mesh, and are gone (as are the
    // canned tree and grove datasets beside this file)
    expect(categories['foliage_trees']).toBeUndefined();
    expect(fs.existsSync(path.join(assetsDir, 'trees_dataset.json'))).toBe(false);
    expect(fs.existsSync(path.join(assetsDir, 'groves_dataset.json'))).toBe(false);
    expect(categories['monuments_temples']).toBe(16);
    expect(categories['archaeology_ruins']).toBe(12);
    expect(categories['urban_infrastructure']).toBe(34);
    expect(
      categories['colosseum_architecture'] +
      categories['monuments_temples'] +
      categories['archaeology_ruins'] +
      categories['urban_infrastructure']
    ).toBe(410);
  });

  it('should verify the 360° Colosseum amphitheater glB model contains 196,568 vertices across ambulatories, hypogeum and 320 bays', () => {
    // public/ copy is gitignored; the identical model is tracked as the spatial-separator asset (6bb97f1).
    const fullGlbPath = [
      path.resolve(__dirname, '../../../public/colosseum_sb_archi_full.glb'),
      path.join(assetsDir, 'colosseum_sb_archi_full.glb')
    ].find(p => fs.existsSync(p)) ?? path.join(assetsDir, 'colosseum_sb_archi_full.glb');
    expect(fs.existsSync(fullGlbPath)).toBe(true);
    const buf = fs.readFileSync(fullGlbPath);
    expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF' magic

    const jsonChunkLength = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonChunkLength));
    const posAccessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];

    expect(posAccessor.count).toBe(196568);
    expect(posAccessor.type).toBe('VEC3');

    // Bounds check in world coordinates
    expect(posAccessor.min[0]).toBeLessThan(-130);
    expect(posAccessor.max[0]).toBeGreaterThan(40);
    expect(posAccessor.min[1]).toBeCloseTo(12.15, 1); // sunken Euripus canal datum (-6.1m below ground 18.25m = 12.15m)
    expect(posAccessor.max[1]).toBeCloseTo(66.75, 1); // attic crest (48.5m height)
  });

  it('should verify monuments (Arch of Constantine, Temple of Venus) have non-empty OBBs', () => {
    const entities = JSON.parse(fs.readFileSync(totalEntitiesPath, 'utf8'));
    const monuments = entities.filter((e: any) => e.category === 'monuments_temples');
    expect(monuments.length).toBe(16);

    const centralFornix = monuments.find((m: any) => m.id === 'tot-arch-const-central-fornix');
    expect(centralFornix).toBeDefined();
    expect(centralFornix.orientedBoundingBox.dimensions[1]).toBeCloseTo(12.2, 0.5);

    const stylobate = monuments.find((m: any) => m.id === 'tot-venus-podium-stylobate');
    expect(stylobate).toBeDefined();
    expect(stylobate.orientedBoundingBox.dimensions[0]).toBeCloseTo(142.0, 1.0);
  });

  it('should verify archaeology ruins and urban palazzi OBB geometric metrics', () => {
    const entities = JSON.parse(fs.readFileSync(totalEntitiesPath, 'utf8'));
    const ruins = entities.filter((e: any) => e.category === 'archaeology_ruins');
    const urban = entities.filter((e: any) => e.category === 'urban_infrastructure');

    expect(ruins.length).toBe(12);
    expect(urban.length).toBe(34);

    const ludusArena = ruins.find((r: any) => r.id === 'tot-ludus-mini-arena');
    expect(ludusArena).toBeDefined();
    expect(ludusArena.orientedBoundingBox.dimensions[0]).toBeCloseTo(62.0, 1.0);

    const palazzoSalvi = urban.filter((u: any) => u.id.startsWith('tot-palazzo-salvi-'));
    expect(palazzoSalvi.length).toBe(10);

    const palazzoFori = urban.filter((u: any) => u.id.startsWith('tot-palazzo-fori-'));
    expect(palazzoFori.length).toBe(10);

    const lanterns = urban.filter((u: any) => u.id.startsWith('tot-street-lantern-'));
    expect(lanterns.length).toBe(8);
  });
});
