import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Gallery Pipeline Asset Integrity & Isolation', () => {
  const publicDir = path.resolve(__dirname, '../../../public');
  const galleryPath = path.join(publicDir, 's4d_multi_gallery.html');

  it('gallery HTML exists and contains parseable evaluationsData', () => {
    expect(fs.existsSync(galleryPath)).toBe(true);
    const html = fs.readFileSync(galleryPath, 'utf8');
    const match = html.match(/const evaluationsData = (\[.*?\]);/s);
    expect(match).toBeTruthy();
    const data = JSON.parse(match![1]);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(6);
  });

  it('strictly isolates textured vs clay assets for 3D Tiles districts', () => {
    const html = fs.readFileSync(galleryPath, 'utf8');
    const match = html.match(/const evaluationsData = (\[.*?\]);/s);
    const data = JSON.parse(match![1]);

    const texturedDist = data.find((d: any) => d.id === 's4d_google_tiles_textured_01');
    const clayDist = data.find((d: any) => d.id === 's4d_google_tiles_clay_01');

    expect(texturedDist).toBeDefined();
    expect(clayDist).toBeDefined();

    // Textured District assertions
    expect(texturedDist.videoSources.comparison.local).toContain('textured');
    expect(texturedDist.videoSources.comparison.local).not.toContain('clay');
    expect(texturedDist.videoSources.blockout.local).toContain('textured');
    expect(texturedDist.videoSources.blockout.local).not.toContain('clay');
    texturedDist.storyboardBeats.forEach((beat: string) => {
      expect(beat).toContain('textured');
      expect(beat).not.toContain('clay');
      expect(fs.existsSync(path.join(publicDir, beat))).toBe(true);
    });

    // Clay District assertions
    expect(clayDist.videoSources.comparison.local).toContain('clay');
    expect(clayDist.videoSources.comparison.local).not.toContain('textured');
    expect(clayDist.videoSources.blockout.local).toContain('clay');
    expect(clayDist.videoSources.blockout.local).not.toContain('textured');
    clayDist.storyboardBeats.forEach((beat: string) => {
      expect(beat).toContain('clay');
      expect(beat).not.toContain('textured');
      expect(fs.existsSync(path.join(publicDir, beat))).toBe(true);
    });

    // All referenced videos must exist and be > 0 bytes
    for (const dist of [texturedDist, clayDist]) {
      for (const key of ['synthesis', 'blockout', 'comparison']) {
        const localRel = dist.videoSources[key].local;
        const fullPath = path.join(publicDir, localRel);
        expect(fs.existsSync(fullPath)).toBe(true);
        expect(fs.statSync(fullPath).size).toBeGreaterThan(0);
      }
    }
  });

  it('validates Plaza Hotel NYC district assets and isolation', () => {
    const html = fs.readFileSync(galleryPath, 'utf8');
    const match = html.match(/const evaluationsData = (\[.*?\]);/s);
    const data = JSON.parse(match![1]);

    const plazaDist = data.find((d: any) => d.id === 's4d_plaza_hotel_01');
    expect(plazaDist).toBeDefined();

    expect(plazaDist.videoSources.comparison.local).toBe('videos/plaza_hotel_vs_omni_comparison.mp4');
    expect(plazaDist.videoSources.synthesis.local).toBe('videos/plaza_hotel_omni_restyled.mp4');
    expect(plazaDist.videoSources.blockout.local).toBe('videos/plaza_hotel_blockout_camera.mp4');

    expect(plazaDist.storyboardBeats.length).toBe(8);
    plazaDist.storyboardBeats.forEach((beat: string) => {
      expect(beat).toContain('storyboards_plaza');
      expect(fs.existsSync(path.join(publicDir, beat))).toBe(true);
    });

    for (const key of ['synthesis', 'blockout', 'comparison']) {
      const localRel = plazaDist.videoSources[key].local;
      const fullPath = path.join(publicDir, localRel);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).size).toBeGreaterThan(1000000); // > 1MB
    }

    expect(plazaDist.qaKeyframes.length).toBe(6);
    plazaDist.qaKeyframes.forEach((kf: any) => {
      expect(fs.existsSync(path.join(publicDir, kf.src))).toBe(true);
    });
  });
});

