import { test } from 'vitest';
import * as assert from 'assert';
import { morphArtifact, MORPH_TARGETS } from '../src/browser/generative-canvas/primitive-transformer-engine';
import type { CanvasArtifact, PrimitiveType } from '../src/browser/generative-canvas/canvas-types';

/** Minimal real (not mocked) data for each source type MORPH_TARGETS lists, just enough for morphArtifact's branches to run without throwing. */
function minimalArtifact(type: PrimitiveType): CanvasArtifact {
    const base = { id: `art-${type}`, title: `Test ${type}`, summary: '', createdAt: new Date().toISOString(), version: 1 };
    const dataByType: Partial<Record<PrimitiveType, any>> = {
        'markdown-document': { title: 'The Battle of Lexington', sections: [{ id: 's1', type: 'heading', level: 1, content: 'The Battle of Lexington' }, { id: 's2', type: 'paragraph', content: 'On April 19, 1775, colonial militia gathered on Lexington Green facing British regulars.' }] },
        '3d-scene': { title: 'Scene', customMeshes: [{ id: 'm1', name: 'Mesh', type: 'box', position: [0, 0, 0] }] },
        'kanban-board': { title: 'Board', columns: [{ id: 'c1', title: 'To Do', cards: [{ id: 'card1', title: 'Task', description: '', tag: '', tagColor: 'blue', priority: 'low' }] }] },
        'node-graph': { title: 'Graph', nodes: [{ id: 'n1', label: 'Node', category: 'process', color: 'blue', x: 0, y: 0 }], edges: [] },
        'metric-dashboard': { title: 'Metrics', metrics: [{ id: 'm1', label: 'Value', value: '1', change: '', trend: 'neutral', icon: 'activity', color: 'blue', sparkline: [1] }] },
        'live-code-sandbox': { title: 'Sandbox', template: 'react', viewMode: 'code', activeFileId: 'f1', files: [{ id: 'f1', name: 'App.tsx', language: 'typescript', content: '' }] },
        'interactive-browser': { url: 'https://example.com', title: 'Example', viewportMode: 'desktop', history: ['https://example.com'], historyIndex: 0, isLoading: false, consoleLogs: [], inspectMode: false, deviceScale: 1 }
    };
    return { ...base, type, data: dataByType[type] ?? {} } as CanvasArtifact;
}

test('MORPH_TARGETS matches what morphArtifact actually implements (no dead "View As" options)', () => {
    const sourceTypes = Object.keys(MORPH_TARGETS) as PrimitiveType[];
    assert.ok(sourceTypes.length > 0);

    for (const sourceType of sourceTypes) {
        const targets = MORPH_TARGETS[sourceType]!;
        const source = minimalArtifact(sourceType);
        for (const targetType of targets) {
            const result = morphArtifact(source, targetType);
            assert.strictEqual(result.type, targetType,
                `MORPH_TARGETS says ${sourceType} -> ${targetType} works, but morphArtifact returned type "${result.type}" instead — the menu would offer a dead option`);
            assert.ok(result.data, `morphArtifact(${sourceType} -> ${targetType}) returned no data`);
        }
    }
});
