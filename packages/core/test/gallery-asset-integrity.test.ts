import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { requireAssets, withReason } from './helpers/requirements';

const VIDEO_KEYS = ['synthesis', 'blockout', 'comparison'] as const;

/**
 * Repo-relative paths of the (gitignored) gallery videos a district references, read from the tracked
 * gallery HTML at collection time so the skip reason names exactly the missing files.
 */
function districtVideos(galleryPath: string, ids: string[]): string[] {
  try {
    const html = fs.readFileSync(galleryPath, 'utf8');
    const data = JSON.parse(html.match(/const evaluationsData = (\[.*?\]);/s)![1]);
    return ids.flatMap(id => {
      const dist = data.find((d: any) => d.id === id);
      return dist ? VIDEO_KEYS.map(k => `public/${dist.videoSources[k].local}`) : [];
    });
  } catch {
    return []; // the parse itself is asserted by the first test
  }
}

describe('Gallery Pipeline Asset Integrity & Isolation', () => {
  const publicDir = path.resolve(__dirname, '../../../public');
  const galleryPath = path.join(publicDir, 's4d_multi_gallery.html');
  const tilesVideos = requireAssets(districtVideos(galleryPath, ['s4d_google_tiles_textured_01', 's4d_google_tiles_clay_01']));
  const plazaVideos = requireAssets(districtVideos(galleryPath, ['s4d_plaza_hotel_01']));

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
  });

  it.skipIf(!tilesVideos.ok)(withReason('3D Tiles districts reference existing, non-empty textured and clay videos', tilesVideos), () => {
    const html = fs.readFileSync(galleryPath, 'utf8');
    const match = html.match(/const evaluationsData = (\[.*?\]);/s);
    const data = JSON.parse(match![1]);

    const texturedDist = data.find((d: any) => d.id === 's4d_google_tiles_textured_01');
    const clayDist = data.find((d: any) => d.id === 's4d_google_tiles_clay_01');

    // All referenced videos must exist and be > 0 bytes
    for (const dist of [texturedDist, clayDist]) {
      for (const key of VIDEO_KEYS) {
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

    expect(plazaDist.qaKeyframes.length).toBe(6);
    plazaDist.qaKeyframes.forEach((kf: any) => {
      expect(fs.existsSync(path.join(publicDir, kf.src))).toBe(true);
    });
  });

  it.skipIf(!plazaVideos.ok)(withReason('Plaza Hotel NYC district references existing, non-empty videos', plazaVideos), () => {
    const html = fs.readFileSync(galleryPath, 'utf8');
    const match = html.match(/const evaluationsData = (\[.*?\]);/s);
    const data = JSON.parse(match![1]);
    const plazaDist = data.find((d: any) => d.id === 's4d_plaza_hotel_01');

    for (const key of VIDEO_KEYS) {
      const localRel = plazaDist.videoSources[key].local;
      const fullPath = path.join(publicDir, localRel);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).size).toBeGreaterThan(0); // non-zero valid video file
    }
  });
});

