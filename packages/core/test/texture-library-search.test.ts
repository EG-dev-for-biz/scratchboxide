/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** texture_library_search's ranking on metal share, the metalness-map filter and normal relief (synthetic entries). */

import { describe, expect, it } from 'vitest';
import { searchTextureLibrary, TEXTURE_LIBRARY_SCHEMA, type TextureLibraryEntry, type TextureLibraryIndex } from '../src/common/spatial/texture-library-index';

const set = (id: string, extra: Partial<TextureLibraryEntry>): TextureLibraryEntry => ({
    id, publisher: 'test', maps: { color: `${id}/c.png` }, downloadMB: 1, sizeSource: 'test', appearance: id, tags: [], provenance: 'library', ...extra
});
const index: TextureLibraryIndex = {
    schema: TEXTURE_LIBRARY_SCHEMA, about: '', bucket: 'b', builtAt: '',
    sets: [
        set('masonry', { roughnessMean: 0.8, metallic: 0, normalTiltRmsDeg: 18 }),
        set('render', { roughnessMean: 0.8, metallic: 0, normalTiltRmsDeg: 1.5 }),
        set('sheet', { maps: { color: 'sheet/c.png', metalness: 'sheet/m.png' }, metallic: 0.95, metalShare: 0.97, metalnessP95: 1, normalTiltRmsDeg: 3 }),
        set('flecks', { maps: { color: 'flecks/c.png', arm: 'flecks/arm.png' }, metallic: 0.2, metalShare: 0.15, metalnessP95: 1, normalTiltRmsDeg: 5 }),
        set('unmeasured', { maps: { color: 'u/c.png', metalness: 'u/m.png' } })
    ]
};
const ids = (q: Parameters<typeof searchTextureLibrary>[1]) => searchTextureLibrary(index, q).hits.map(h => h.entry.id);

describe('searchTextureLibrary: metal share, metalness map and normal relief', () => {
    it('keeps only sets with a metalness map when asked, and ranks a solid metal sheet above metal flecks of the same p95', () => {
        expect(ids({ hasMetalnessMap: true, metalShare: 0.9 })).toEqual(['sheet', 'unmeasured', 'flecks']); // flecks lie 3 units off; an unmeasured share counts 1
        expect(ids({ hasMetalnessMap: false })).toEqual(['masonry', 'render']);
    });
    it('compares a set without a metalness map as metal share 0, and an unmeasured share as one unit', () => {
        const hits = searchTextureLibrary(index, { metalShare: 0 }).hits;
        expect(hits.find(h => h.entry.id === 'render')!.compared).toContain('metal share');
        expect(hits.find(h => h.entry.id === 'unmeasured')!.unmeasured).toContain('metal share');
    });
    it('tells rough masonry from smooth render by normal tilt', () => {
        expect(ids({ normalTiltDeg: 15, roughness: 0.8 })[0]).toBe('masonry');
        expect(ids({ normalTiltDeg: 1, roughness: 0.8 })[0]).toBe('render');
    });
});
