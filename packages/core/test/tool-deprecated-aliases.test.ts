import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry, DEPRECATED_TOOL_ALIASES } from '../src/node/gemini/tool-registry';
import { ALL_TOOL_PACKS, type ToolPackName } from '../src/node/gemini/domain-tool-packs';
import { geoboxPrecisionHandlers, GEOBOX_RESECTION_ALIAS_TOOL_NAMES } from '../src/node/gemini/tools/spatial-tools';
import { PROMPT_TEMPLATE_TOOL_NAMES } from '../src/node/gemini/tools/vfx-video-tools';

/**
 * Deprecated tool names stay registered for one release so saved scripts and chats keep working, but the model
 * is not offered them: not by group, not by pack, and not in the request's function declarations.
 */
describe('deprecated tool aliases', () => {
    const registry = createDefaultToolRegistry();

    it('lists the resection aliases and the prompt-template tools as deprecated', () => {
        expect([...DEPRECATED_TOOL_ALIASES].sort()).toEqual([...GEOBOX_RESECTION_ALIAS_TOOL_NAMES, ...PROMPT_TEMPLATE_TOOL_NAMES].sort());
        expect(GEOBOX_RESECTION_ALIAS_TOOL_NAMES).toEqual(['geobox_resect_camera_pose', 'spatial_resect_image_location']);
        expect(PROMPT_TEMPLATE_TOOL_NAMES).toEqual(['build_beautify_prompt', 'build_neutral_performer_prompt', 'build_frame_motivated_performer_prompt']);
    });

    it('registers every deprecated tool with a handler and a description that names the replacement and the removal note', () => {
        for (const name of DEPRECATED_TOOL_ALIASES) {
            const reg = registry.get(name);
            expect(reg, name).toBeDefined();
            expect(typeof reg!.handler).toBe('function');
            expect(reg!.offeredByDefault).toBe(false);
            expect(reg!.declaration.description).toMatch(/^DEPRECATED (?:alias of [a-z0-9_]+ )?\(hidden since 2026-10-20; remove after one release\)/);
        }
    });

    it('offers no deprecated tool by group nor by any pack, while the kept tools are offered', () => {
        const offered = new Set(registry.declarations().map(d => d.name));
        expect(offered.has('geobox_resect_image_location')).toBe(true);
        expect(offered.has('survey_beautify_station')).toBe(true);
        expect(offered.has('spatial_ai_render_scene')).toBe(true);
        for (const name of DEPRECATED_TOOL_ALIASES) expect(offered.has(name), name).toBe(false);

        const packNames = Object.keys(ALL_TOOL_PACKS) as ToolPackName[];
        const byPack = new Set(registry.declarationsForPacks(packNames).map(d => d.name));
        expect(byPack.has('geobox_resect_image_location')).toBe(true);
        for (const name of DEPRECATED_TOOL_ALIASES) expect(byPack.has(name), name).toBe(false);
    });

    it('dispatches each resection alias to the kept handler with the same result', async () => {
        const args = {
            imagePath: 'public/test_images/urban_scene.jpg',
            targetCoords: { lat: 40.741, lng: -73.9897, alt: 12 },
            headingDeg: 210,
            pitchDeg: 8,
            standoffDistanceMeters: 180
        };
        const kept = await registry.dispatch('geobox_resect_image_location', args, {} as any);
        expect(kept.exec.status).toBe('completed');
        for (const name of GEOBOX_RESECTION_ALIAS_TOOL_NAMES) {
            const viaAlias = await registry.dispatch(name, args, {} as any);
            expect(viaAlias.exec.status, name).toBe('completed');
            const { resectionTimestamp: _a, ...aliasPayload } = viaAlias.resultPayload as any;
            const { resectionTimestamp: _k, ...keptPayload } = kept.resultPayload as any;
            expect(aliasPayload, name).toEqual(keptPayload);
            expect(viaAlias.exec.summaryResult, name).toBe(kept.exec.summaryResult);
        }
    });

    it('the alias handlers are the kept handler by delegation (no second implementation)', async () => {
        // Each alias handler forwards to geobox_resect_image_location: an evidence-less call fails with the same
        // MissingInputError text, naming the kept tool, from every name.
        const messages: string[] = [];
        for (const name of ['geobox_resect_image_location', ...GEOBOX_RESECTION_ALIAS_TOOL_NAMES]) {
            await expect(geoboxPrecisionHandlers[name]({}, {} as any)).rejects.toThrow(/geobox_resect_image_location/);
            try { await geoboxPrecisionHandlers[name]({}, {} as any); } catch (err: any) { messages.push(err.message); }
        }
        expect(new Set(messages).size).toBe(1);
    });
});
