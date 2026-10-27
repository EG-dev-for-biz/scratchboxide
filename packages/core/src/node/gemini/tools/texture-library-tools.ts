/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * texture_library_search: searches the texture library's index (assets/textures/library/index.json) for the material
 * sets nearest a wanted colour, finish, metalness and tile size, so a script's librarySets are names the library holds
 * rather than guesses. Ranking is searchTextureLibrary's (continuous quantities only); the text words only filter.
 * The index holds publisher metadata only: before ranking by colour or finish, the sets in the search's pool that have
 * not been measured yet (at most MEASURE_PER_SEARCH, nearest the wanted tile size first) are measured on their
 * publishers' preview maps and cached, so the library is measured only as far as searches need it.
 */

import { entryHasMetalnessMap, searchTextureLibrary, textureLibraryPool, type TextureLibraryQuery } from '../../../common/spatial/texture-library-index';
import { libraryEntryMeasured, loadTextureLibraryIndex, measureLibraryEntries } from '../../3d-engine/texture-library';
import { resolveRepoRoot } from './nano-banana-tools';
import type { ToolDeclaration, ToolHandler } from './types';

export const TEXTURE_LIBRARY_SEARCH_TOOL = 'texture_library_search';
/** Sets measured on demand per search; the rest of a large pool stays unmeasured and the result says how many. */
export const MEASURE_PER_SEARCH = 40;

export const TEXTURE_LIBRARY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: TEXTURE_LIBRARY_SEARCH_TOOL,
        description: 'Search the texture library (photographed and scanned ambientCG and Poly Haven PBR sets) for the sets nearest a wanted look, '
            + 'before naming any in execute_3d_python_script\'s librarySets. Ranks every set with a colour map by its measured colour (CIELAB), '
            + 'roughness, metalness (mean and metal share), normal relief and the real size one tile spans; text words filter by the publisher\'s names, tags and descriptions. '
            + 'Returns set names with their real size (and where it came from), mean colour, roughness and appearance text; a quantity the index '
            + 'could not measure is listed as unmeasured, never guessed. Colour and finish are measured on demand for at most '
            + `${MEASURE_PER_SEARCH} not-yet-measured sets per search (a few seconds; cached after), so give text words that narrow the pool to the material wanted. Search once per surface (walls, trim, stone base, roof, glass frames, `
            + 'ground) with the colour read for it, and pass the top few names per surface as librarySets.',
        parameters: {
            type: 'OBJECT',
            properties: {
                colorSrgb: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional: wanted colour as sRGB 0..1 [r, g, b], e.g. a read wall colour. Hue and chroma weigh most; lightness less, since sb.library_surface tints the chosen set.' },
                colorSpreadLab: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional, only when measured (never estimated): the surface\'s colour variation as a CIELAB standard deviation [L, a, b], e.g. sb.site_colors\' wall_spread_lab with L set to -1 (a negative L leaves lightness variation out); sets whose own variation is nearest rank first. Without it, a set with no hue variation (a greyscale map) still ranks lower for a coloured target.' },
                roughness: { type: 'NUMBER', description: 'Optional: wanted finish, 0 polished .. 1 matte.' },
                metallic: { type: 'NUMBER', description: 'Optional: wanted metalness, 0 dielectric .. 1 metal.' },
                metalShare: { type: 'NUMBER', description: 'Optional: wanted share of the surface that is metal (metalness at least 0.5), 0..1.' },
                normalTiltDeg: { type: 'NUMBER', description: 'Optional: wanted normal relief as an RMS tilt in degrees: about 2 for a smooth render or sheet, 10-25 for rough masonry.' },
                hasMetalnessMap: { type: 'BOOLEAN', description: 'Optional: true keeps only sets that have a metalness map (the only ones that can show metal); false only sets without one.' },
                tileSizeM: { type: 'NUMBER', description: 'Optional: wanted real size of one tile in metres (its longer side), compared as a ratio: about 1-2 for a wall finish seen from the street, 0.2-0.5 for fine detail.' },
                text: { type: 'STRING', description: 'Optional: alternative words, at least one of which must appear in a set\'s name, tags or description, e.g. "limestone sandstone" or "aluminium steel". When no set matches any, the ranking runs without the filter and says so.' },
                limit: { type: 'NUMBER', description: 'Optional: how many sets to return (default 8, at most 40).' }
            }
        }
    }
];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function createTextureLibrarySearchHandler(deps: { repoRoot?: () => string; measure?: typeof measureLibraryEntries } = {}): ToolHandler {
    return async (args, ctx) => {
        const repoRoot = (deps.repoRoot ?? resolveRepoRoot)();
        let index = loadTextureLibraryIndex(repoRoot);
        if (!index) {
            throw new Error(`${TEXTURE_LIBRARY_SEARCH_TOOL}: the texture library index (assets/textures/library/index.json) has not been built; run scripts/build_texture_library_index.ts`);
        }
        const rgb = Array.isArray(args.colorSrgb) ? (args.colorSrgb as unknown[]).map(Number) : undefined;
        const q: TextureLibraryQuery = {
            ...(rgb && rgb.length === 3 && rgb.every(Number.isFinite) ? { colorSrgb: rgb.map(c => (c > 1 ? c / 255 : c)) as [number, number, number] } : {}),
            ...(Array.isArray(args.colorSpreadLab) && (args.colorSpreadLab as unknown[]).length === 3 && (args.colorSpreadLab as unknown[]).every(v => num(v) !== undefined) && (args.colorSpreadLab as number[]).slice(1).every(v => v >= 0)
                ? { colorSpreadLab: (args.colorSpreadLab as number[]).slice(0, 3) as [number, number, number] } : {}),
            ...(num(args.roughness) !== undefined ? { roughness: num(args.roughness) } : {}),
            ...(num(args.metallic) !== undefined ? { metallic: num(args.metallic) } : {}),
            ...(num(args.metalShare) !== undefined ? { metalShare: num(args.metalShare) } : {}),
            ...(num(args.normalTiltDeg) !== undefined ? { normalTiltDeg: num(args.normalTiltDeg) } : {}),
            ...(typeof args.hasMetalnessMap === 'boolean' ? { hasMetalnessMap: args.hasMetalnessMap } : {}),
            ...(num(args.tileSizeM) !== undefined && num(args.tileSizeM)! > 0 ? { tileSizeM: num(args.tileSizeM) } : {}),
            ...(typeof args.text === 'string' && args.text.trim() ? { text: args.text.trim() } : {}),
            limit: Math.min(40, Math.max(1, Math.round(num(args.limit) ?? 8)))
        };
        // measure, on demand, the pool's sets not measured yet: nearest the wanted tile size first (unknown sizes last)
        let measuredNow: string[] = [], failedNow: Array<{ id: string; reason: string }> = [], unmeasuredLeft = 0;
        if (q.colorSrgb || q.colorSpreadLab || q.roughness !== undefined || q.metallic !== undefined || q.metalShare !== undefined || q.normalTiltDeg !== undefined) {
            const sizeGap = (e: { realSizeM?: [number, number] }) => (q.tileSizeM && e.realSizeM ? Math.abs(Math.log(Math.max(...e.realSizeM) / q.tileSizeM)) : e.realSizeM ? 0 : 99);
            const unmeasured = textureLibraryPool(index, q).pool
                .filter(e => !libraryEntryMeasured(repoRoot, e.id))
                .sort((a, b) => sizeGap(a) - sizeGap(b) || a.id.localeCompare(b.id));
            if (unmeasured.length) {
                ctx?.reportProgress?.(`texture library: measuring ${Math.min(unmeasured.length, MEASURE_PER_SEARCH)} sets' colour and finish on their preview maps`);
                const r = await (deps.measure ?? measureLibraryEntries)(unmeasured.slice(0, MEASURE_PER_SEARCH), { repoRoot, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
                measuredNow = r.measured; failedNow = r.failed;
                unmeasuredLeft = Math.max(0, unmeasured.length - MEASURE_PER_SEARCH);
                index = loadTextureLibraryIndex(repoRoot)!;
            }
        }
        const { hits, textMatched } = searchTextureLibrary(index, q);
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        const sets = hits.map(({ entry: e, distance, compared, unmeasured }) => ({
            name: e.id,
            publisher: e.publisher,
            distance: Math.round(distance * 100) / 100,
            ...(e.realSizeM ? { realSizeM: e.realSizeM } : {}),
            sizeSource: e.sizeSource,
            ...(e.colour ? { meanSrgb: e.colour.meanLinearRgb.map(c => r3(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)), meanLab: e.colour.meanLab, spreadLab: e.colour.spreadLab } : {}),
            ...(e.roughnessMean !== undefined ? { roughness: e.roughnessMean } : {}),
            ...(e.metallic !== undefined ? { metallic: e.metallic } : {}),
            hasMetalnessMap: entryHasMetalnessMap(e),
            ...(e.metalShare !== undefined ? { metalShare: e.metalShare, metalnessP95: e.metalnessP95 } : {}),
            ...(e.normalTiltRmsDeg !== undefined ? { normalTiltRmsDeg: e.normalTiltRmsDeg } : {}),
            appearance: e.appearance,
            tags: e.tags.slice(0, 12),
            ...(unmeasured.length ? { unmeasured } : {}),
            compared,
            ...(e.notes?.length ? { notes: e.notes } : {})
        }));
        const { pool } = textureLibraryPool(index, q);
        const summary = `Searched ${pool.length} texture library sets${q.text ? (textMatched ? ` matching "${q.text}"` : ` (no set matches "${q.text}"; ranked all)`) : ''}`
            + (measuredNow.length ? `, measuring ${measuredNow.length} on demand` : '') + (unmeasuredLeft ? ` (${unmeasuredLeft} still unmeasured)` : '') + ': '
            + sets.slice(0, 5).map(s => s.name).join(', ') + (sets.length > 5 ? ', ...' : '') + '.';
        return {
            resultPayload: {
                success: true, sets, textMatched, query: q, setsSearched: pool.length, indexBuiltAt: index.builtAt,
                measuredNow: measuredNow.length, ...(failedNow.length ? { notMeasurable: failedNow } : {}),
                ...(unmeasuredLeft ? { stillUnmeasured: unmeasuredLeft, hint: 'Sets not measured yet rank as if unmeasured; narrower text words (or another search) measure more of them.' } : {}),
                about: 'distance: 1 is about one clearly visible difference per compared quantity; an unmeasured quantity counts as 1.'
            },
            summaryResult: summary
        };
    };
}

export const textureLibraryHandlers: Record<string, ToolHandler> = {
    [TEXTURE_LIBRARY_SEARCH_TOOL]: createTextureLibrarySearchHandler()
};
