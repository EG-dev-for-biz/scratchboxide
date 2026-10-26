import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { buildToolNodeCatalog, packTitle } from '../src/node/gemini/tool-node-catalog';
import { coerceToolArgInput, compactResultFields, isToolNode, resolveToolNodeArgs, summarizeToolOutput, toolCallsToNodeGraph, toolRunOrder, type ToolGraphNode } from '../src/common/tool-node-graph';

describe('tool node catalog', () => {
    const registry = createDefaultToolRegistry();
    const catalog = buildToolNodeCatalog(registry);

    it('lists every registered tool exactly once', () => {
        const names = catalog.map(t => t.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.sort()).toEqual(registry.names().sort());
        expect(names.length).toBeGreaterThan(130);
        for (const t of ['google_3d_tiles_get_clay', 'mesh_inspect', 'survey_beautify_station', 'workspace_read_file', 'lens_project']) expect(names).toContain(t);
    });

    it('titles each tool by the declaration list it comes from', () => {
        expect(catalog.find(t => t.name === 'google_3d_tiles_get_clay')!.pack).toBe('Google 3D Tiles');
        expect(catalog.find(t => t.name === 'mesh_inspect')!.pack).toBe('Mesh Shaping');
        expect(catalog.find(t => t.name === 'ask_user_question')!.pack).toBe('Canvas');
        expect(packTitle('SB_ROADIE_TOOL_DECLARATIONS')).toBe('SB Roadie');
        expect(packTitle('IMAGE_TO_PBR_TOOL_DECLARATIONS')).toBe('Image to Pbr');
        const unlisted = catalog.filter(t => t.pack === 'Other tools').map(t => t.name);
        // every tool should come from a known declaration list; a new list needs adding to tool-node-catalog.ts
        expect(unlisted.length).toBeLessThan(catalog.length * 0.1);
    });

    it('carries each tool\'s own parameter declaration', () => {
        const tool = catalog.find(t => t.name === 'mesh_inspect')!;
        expect(tool.parameters).toEqual(registry.get('mesh_inspect')!.declaration.parameters);
        expect(tool.description.length).toBeGreaterThan(20);
    });
});

describe('tool node graph rules', () => {
    const glb = { id: 'a', parameters: { toolName: 'google_3d_tiles_get_clay', toolArgs: {} }, outputData: { resultPayload: { status: 'success', data: { glbPath: 'public/models/a.glb', vertexCount: 1200 } } } };
    const far = { id: 'b', parameters: { toolName: 'x', toolArgs: {} }, outputData: { resultPayload: { glbPath: 'public/models/far.glb', stationId: 7 } } };
    const target: ToolGraphNode = { id: 'c', parameters: { toolName: 'mesh_inspect', toolArgs: { mode: 'stats', note: '' } } };
    const schema = { type: 'OBJECT' as const, properties: { glbPath: { type: 'STRING' as const }, mode: { type: 'STRING' as const }, stationId: { type: 'NUMBER' as const }, maxDepth: { type: 'NUMBER' as const } }, required: ['glbPath', 'maxDepth'] };

    it('fills empty inputs by name from the nearest upstream output, keeping the node\'s own values', () => {
        const r = resolveToolNodeArgs(target, [far, glb, target], [{ source: 'b', target: 'a' }, { source: 'a', target: 'c' }], schema);
        expect(r.args).toEqual({ mode: 'stats', glbPath: 'public/models/a.glb', stationId: 7 });
        expect(r.filledFrom).toEqual({ glbPath: 'a', stationId: 'b' });
        expect(r.missingRequired).toEqual(['maxDepth']);
    });

    it('orders tool nodes after the nodes they read from, skipping non-tool nodes', () => {
        const note = { id: 'n' };
        const order = toolRunOrder([target, note, glb, far], [{ source: 'b', target: 'a' }, { source: 'a', target: 'n' }, { source: 'n', target: 'c' }]);
        expect(order.map(n => n.id)).toEqual(['b', 'a', 'c']);
        expect(isToolNode(note)).toBe(false);
    });

    it('types form input by the parameter schema', () => {
        expect(coerceToolArgInput('2.5', { type: 'NUMBER' })).toBe(2.5);
        expect(coerceToolArgInput('[1,2]', { type: 'ARRAY' })).toEqual([1, 2]);
        expect(coerceToolArgInput('', { type: 'STRING' })).toBeUndefined();
        expect(() => coerceToolArgInput('abc', { type: 'NUMBER' })).toThrow();
        expect(() => coerceToolArgInput('{"a":1}', { type: 'ARRAY' })).toThrow();
    });

    it('summarises output fields and finds file paths at any depth', () => {
        const s = summarizeToolOutput({ status: 'success', data: { glbPath: 'public/models/a.glb', vertexCount: 1200, views: [{ png: '/tmp/x/view_01.png' }] } });
        expect(s.fields).toContainEqual({ key: 'vertexCount', value: '1200' });
        expect(s.files.sort()).toEqual(['/tmp/x/view_01.png', 'public/models/a.glb']);
    });
});

describe('chat tool calls as a node graph', () => {
    const calls = [
        { id: '1', toolName: 'mount_canvas_primitive', status: 'completed' as const, args: { primitiveType: '3d-scene' }, resultFields: {} },
        { id: '2', toolName: 'google_3d_tiles_get_clay', status: 'completed' as const, args: { query: 'Haughwout Building, New York', isolate: true }, resultFields: { glbPath: 'public/models/h.glb', vertexCount: 116000 }, durationMs: 90_000 },
        { id: '3', toolName: 'mesh_inspect', status: 'failed' as const, args: { inputGlbPath: 'public/models/h.glb' }, resultFields: {}, summaryResult: 'Failed: no binary' },
        { id: '4', toolName: 'atmosphere_calculate_solar_position', status: 'completed' as const, args: { latitude: 40.72181, longitude: -73.99949, isoDate: '2026-10-24T15:00:00Z' }, resultFields: { elevationDeg: 32.510201644520116 } },
        // as seen live: the model passed the returned elevation back rounded to 15 digits
        { id: '5', toolName: 'atmosphere_get_diurnal_profile', status: 'completed' as const, args: { elevationDeg: 32.5102016445201 }, resultFields: {} },
        { id: '6', toolName: 'mesh_edit', status: 'completed' as const, resultFields: {} },
        { id: '7', toolName: 'tile_refine', status: 'running' as const, args: {} }
    ];
    const g = toolCallsToNodeGraph(calls, name => name !== 'mount_canvas_primitive');

    it('keeps runnable finished calls in call order, with their arguments as node inputs', () => {
        expect(g.nodes.map(n => n.subtitle)).toEqual(['google_3d_tiles_get_clay', 'mesh_inspect', 'atmosphere_calculate_solar_position', 'atmosphere_get_diurnal_profile']);
        expect(g.nodes[0].parameters).toEqual({ toolName: 'google_3d_tiles_get_clay', toolArgs: { query: 'Haughwout Building, New York', isolate: true } });
        expect(g.nodes.every(isToolNode)).toBe(true);
        expect(g.nodes[1].status).toBe('error');
        expect(g.skipped.map(s => s.toolName)).toEqual(['mount_canvas_primitive', 'mesh_edit', 'tile_refine']);
    });

    it('links a call to the earlier call whose result it used, naming the field', () => {
        expect(g.edges.map(e => [e.source, e.target, e.label])).toEqual([
            ['call-1-google_3d_tiles_get_clay', 'call-2-mesh_inspect', 'glbPath → inputGlbPath'],
            ['call-3-atmosphere_calculate_solar_position', 'call-4-atmosphere_get_diurnal_profile', 'elevationDeg']
        ]);
        expect(toolRunOrder(g.nodes, g.edges).map(n => n.id)[0]).toBe('call-1-google_3d_tiles_get_clay');
    });

    it('re-runs take linked inputs fresh from upstream, through the edge field map', () => {
        const inspect = g.nodes[1];
        expect(inspect.parameters?.toolArgs).toEqual({});
        expect(inspect.outputData.recordedArgs).toEqual({ inputGlbPath: 'public/models/h.glb' });
        // the upstream build ran again and wrote a new file
        const rebuilt = { ...g.nodes[0], outputData: { resultPayload: { glbPath: 'public/models/h2.glb' } } };
        const r = resolveToolNodeArgs(inspect, [rebuilt, inspect], g.edges, { type: 'OBJECT', properties: { inputGlbPath: { type: 'STRING' } }, required: ['inputGlbPath'] });
        expect(r.args).toEqual({ inputGlbPath: 'public/models/h2.glb' });
        expect(r.filledFrom).toEqual({ inputGlbPath: 'call-1-google_3d_tiles_get_clay' });
    });

    it('keeps only short result fields with the chat record', () => {
        const f = compactResultFields({ success: true, glbPath: 'a.glb', big: 'x'.repeat(5000), data: { stations: [1, 2, 3], scene: { deep: true } } });
        expect(f).toEqual({ success: true, glbPath: 'a.glb', stations: [1, 2, 3] });
    });
});
