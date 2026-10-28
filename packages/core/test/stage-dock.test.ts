import { describe, expect, it } from 'vitest';
import { clampDockRatio, dockRefusal, dockSideAt, liveDock } from '../src/browser/generative-canvas/studio/stage-dock';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';

const art = (id: string, type: string): CanvasArtifact => ({ id, type, title: id, summary: '', data: {}, createdAt: '', version: 1 } as unknown as CanvasArtifact);
const scene = art('scene', '3d-scene'), graph = art('graph', 'node-graph'), scene2 = art('scene2', '3d-scene');
const rect = { left: 100, top: 50, width: 1000, height: 600 };

describe('the docked frame', () => {
    it('docks a drop near an edge to that edge, and opens a drop in the middle', () => {
        expect(dockSideAt(150, 300, rect)).toBe('left');
        expect(dockSideAt(1050, 300, rect)).toBe('right');
        expect(dockSideAt(600, 600, rect)).toBe('bottom');
        expect(dockSideAt(600, 80, rect)).toBe('top');
        expect(dockSideAt(600, 300, rect)).toBeUndefined();
        // a bottom corner goes to the nearer edge
        expect(dockSideAt(1090, 640, rect)).toBe('right');
        expect(dockSideAt(500, 645, rect)).toBe('bottom');
        expect(dockSideAt(50, 300, rect)).toBeUndefined();
    });

    it('docks a graph beside a scene, never the main view itself or a second 3D viewport', () => {
        expect(dockRefusal(graph, scene)).toBeUndefined();
        expect(dockRefusal(scene, graph)).toBeUndefined();
        expect(dockRefusal(scene, scene)).toBe('it is already the main view');
        expect(dockRefusal(scene2, scene)).toBe('only one 3D viewport can be open at a time');
        expect(dockRefusal(undefined, scene)).toBe('that tab is no longer open');
    });

    it('drops the dock when its tab closes or becomes the main view', () => {
        const dock = { artifactId: 'graph', side: 'right' as const, ratio: 0.4 };
        expect(liveDock(dock, scene, [scene, graph])?.artifact).toBe(graph);
        expect(liveDock(dock, scene, [scene])).toBeUndefined();
        expect(liveDock(dock, graph, [scene, graph])).toBeUndefined();
        expect(liveDock(undefined, scene, [scene, graph])).toBeUndefined();
    });

    it('keeps the docked share between a fifth and four fifths of the stage', () => {
        expect(clampDockRatio(0.05)).toBe(0.2);
        expect(clampDockRatio(0.5)).toBe(0.5);
        expect(clampDockRatio(0.95)).toBe(0.8);
    });
});
