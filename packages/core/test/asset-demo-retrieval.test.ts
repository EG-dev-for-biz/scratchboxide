import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { requireAssets, withReason } from './helpers/requirements';

describe('Public Asset Retrieval & Demo Integrity', () => {
  const publicDir = path.resolve(__dirname, '../../../public');

  describe('1. 3D GLB Models Retrieval', () => {
    const models = [
      {
        name: 'Empire State Building (High-Quality PBR)',
        relPath: 'models/spce_esb_isolated_full_quality_pbr.glb',
        minSizeBytes: 15_000_000, // ~20.1 MB
        producer: 'scripts/generate_isolated_esb_pbr.py'
      },
      {
        name: 'Watertight Remeshed Empire State Building',
        relPath: 'cleaned_empire_state_building.glb',
        minSizeBytes: 10_000_000, // ~13.3 MB
        producer: undefined
      },
      {
        name: 'SB-Human Parametric Rigged Humanoid',
        relPath: 'models/humanoid_10331522.glb',
        minSizeBytes: 5_000_000, // ~9.8 MB
        producer: 'scripts/build_smooth_humanoid_glb.mjs'
      },
      {
        name: 'Midtown Manhattan Lowpoly Map',
        relPath: 'models/google_midtown_lowpoly_map.glb',
        minSizeBytes: 200_000, // ~300 KB
        producer: 'scripts/generate_google_midtown_lowpoly_map.cpp'
      },
      {
        name: 'Analytical Cuboid Blockout',
        relPath: 'models/analytical_cuboid_blockout.glb',
        minSizeBytes: 300_000, // ~427 KB
        producer: 'scripts/generate_analytical_cuboid_blockout.cpp'
      }
    ];

    models.forEach((m) => {
      const asset = requireAssets([`public/${m.relPath}`], m.producer);
      it.skipIf(!asset.ok)(withReason(`retrieves 3D model "${m.name}" from public/${m.relPath}`, asset), () => {
        const fullPath = path.join(publicDir, m.relPath);
        expect(fs.existsSync(fullPath), `Asset file missing: ${m.relPath}`).toBe(true);
        const stats = fs.statSync(fullPath);
        expect(stats.size).toBeGreaterThanOrEqual(m.minSizeBytes);

        // Verify glTF binary magic header (0x46546C67 = "glTF")
        const fd = fs.openSync(fullPath, 'r');
        const header = Buffer.alloc(4);
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        expect(header.toString('ascii')).toBe('glTF');
      });
    });
  });

  describe('2. Real 4K Video Plates Retrieval', () => {
    const videos = [
      {
        name: 'Plaza Hotel 4K Architectural Plate',
        relPath: 'videos/plaza_hotel_blockout_camera.mp4',
        minSizeBytes: 500_000 // ~668 KB
      },
      {
        name: 'Plaza Hotel Omni Restyled 4K Synthesis',
        relPath: 'videos/plaza_hotel_omni_restyled.mp4',
        minSizeBytes: 30_000_000 // ~43.8 MB
      },
      {
        name: 'Plaza Hotel 4K Side-by-Side Comparison',
        relPath: 'videos/plaza_hotel_vs_omni_comparison.mp4',
        minSizeBytes: 5_000_000 // ~5.55 MB
      },
      {
        name: 'Google Photorealistic 3D Tiles 4K Flight',
        relPath: 'videos/google_tiles_textured_blockout_camera.mp4',
        minSizeBytes: 8_000_000 // ~10.8 MB
      }
    ];

    videos.forEach((v) => {
      const asset = requireAssets([`public/${v.relPath}`]);
      it.skipIf(!asset.ok)(withReason(`retrieves video plate "${v.name}" from public/${v.relPath}`, asset), () => {
        const fullPath = path.join(publicDir, v.relPath);
        expect(fs.existsSync(fullPath), `Video file missing: ${v.relPath}`).toBe(true);
        const stats = fs.statSync(fullPath);
        expect(stats.size).toBeGreaterThanOrEqual(v.minSizeBytes);

        // Verify MP4 ftyp box signature within first 16 bytes
        const fd = fs.openSync(fullPath, 'r');
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        fs.closeSync(fd);
        expect(buf.includes(Buffer.from('ftyp'))).toBe(true);
      });
    });
  });

  describe('3. 6-DOF Camera Solve Trajectories Retrieval', () => {
    const plazaPath = requireAssets(['public/models/plaza_hotel_camera_path.json']);
    const tilesPath = requireAssets(['public/models/google_tiles_camera_path.json']);

    it.skipIf(!plazaPath.ok)(withReason('retrieves and parses plaza_hotel_camera_path.json with 361 frames @ 24fps', plazaPath), () => {
      const fullPath = path.join(publicDir, 'models/plaza_hotel_camera_path.json');
      expect(fs.existsSync(fullPath)).toBe(true);

      const content = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.fps).toBe(24);
      expect(data.totalFrames).toBe(361);
      expect(Math.round(data.durationSec)).toBe(15);
      expect(Array.isArray(data.frames)).toBe(true);
      expect(data.frames.length).toBe(361);

      // Verify frame schema
      const f0 = data.frames[0];
      expect(typeof f0.frame).toBe('number');
      expect(f0.position).toHaveLength(3);
      expect(f0.target).toHaveLength(3);
      expect(f0.up).toHaveLength(3);
      expect(typeof f0.fov).toBe('number');
    });

    it.skipIf(!tilesPath.ok)(withReason('retrieves and parses google_tiles_camera_path.json with 72 frames @ 24fps', tilesPath), () => {
      const fullPath = path.join(publicDir, 'models/google_tiles_camera_path.json');
      expect(fs.existsSync(fullPath)).toBe(true);

      const content = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.fps).toBe(24);
      expect(data.totalFrames).toBe(72);
      expect(data.durationSec).toBe(3);
      expect(Array.isArray(data.frames)).toBe(true);
      expect(data.frames.length).toBe(72);
    });
  });

  describe('4. Storyboard Keyframes Retrieval', () => {
    it('retrieves all 8 photogrammetric storyboard beats (beat_00 to beat_07)', () => {
      for (let i = 0; i < 8; i++) {
        const beatName = `beat_0${i}.jpg`;
        const fullPath = path.join(publicDir, 'storyboards_plaza', beatName);
        expect(fs.existsSync(fullPath), `Storyboard missing: ${beatName}`).toBe(true);
        const stats = fs.statSync(fullPath);
        expect(stats.size).toBeGreaterThan(100_000); // JPEG should be > 100KB
      }
    });
  });

  describe('5. Asset Compositor Demo HTML Integrity', () => {
    it('validates public/asset_demo_studio.html exists and binds to retrieved assets', () => {
      const demoPath = path.join(publicDir, 'asset_demo_studio.html');
      expect(fs.existsSync(demoPath)).toBe(true);
      const html = fs.readFileSync(demoPath, 'utf-8');

      // Assert key asset bindings are present
      expect(html).toContain('models/spce_esb_isolated_full_quality_pbr.glb');
      expect(html).toContain('cleaned_empire_state_building.glb');
      expect(html).toContain('models/humanoid_10331522.glb');
      expect(html).toContain('videos/plaza_hotel_blockout_camera.mp4');
      expect(html).toContain('models/plaza_hotel_camera_path.json');
      expect(html).toContain('THREE.GLTFLoader');
    });
  });
});
