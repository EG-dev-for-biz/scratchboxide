/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { decodeLimiter, resilientLoad } from '../src/browser/generative-canvas/primitives/scene3d/resilientGltfLoader';
import { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import { createEmptyProjectGraph, type ProjectArtifactGraph } from '../src/common/project-artifact-graph-protocol';

const P = { concurrency: 2, attempts: 3, retryPauseMs: 1 };
const noPause = () => Promise.resolve();

describe('texture decodes of a model: bounded and retried', () => {
    it('retries a decode that fails, and reports it only after the last try', async () => {
        const tries: Record<string, number> = {};
        const load = (url: string, onLoad: (d: unknown) => void, _p: unknown, onError?: (e: unknown) => void) => {
            tries[url] = (tries[url] ?? 0) + 1;
            // 'flaky' decodes on its third try; 'dead' never does
            setTimeout(() => (url === 'ok' || (url === 'flaky' && tries[url] === 3) ? onLoad(`bitmap:${url}`) : onError?.(new Error(`decode failed ${tries[url]}`))), 0);
        };
        const wrapped = resilientLoad(load, decodeLimiter(P.concurrency), P, noPause);
        const ask = (url: string) => new Promise<unknown>((resolve, reject) => { wrapped(url, resolve, undefined, reject); });
        expect(await ask('ok')).toBe('bitmap:ok');
        expect(await ask('flaky')).toBe('bitmap:flaky');
        expect(tries.flaky).toBe(3);
        await expect(ask('dead')).rejects.toThrow('decode failed 3');
        expect(tries.dead).toBe(3);
    });

    it('never has more decodes in flight than the limit, and every one finishes', async () => {
        let inFlight = 0, most = 0;
        const load = (url: string, onLoad: (d: unknown) => void) => { inFlight++; most = Math.max(most, inFlight); setTimeout(() => { inFlight--; onLoad(url); }, 2); };
        const wrapped = resilientLoad(load, decodeLimiter(P.concurrency), P, noPause);
        const done = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise<unknown>((resolve, reject) => { wrapped(`t${i}`, resolve, undefined, reject); })));
        expect(done).toHaveLength(12);
        expect(most).toBe(2);
    });
});

describe('a change made while the project is still loading', () => {
    it('is saved after the load, not before it (the store refuses a project it did not load)', async () => {
        const events: string[] = [];
        let finishLoad!: (g: ProjectArtifactGraph) => void;
        const client = {
            load: () => { events.push('load asked'); return new Promise<ProjectArtifactGraph>(r => { finishLoad = g => { events.push('load done'); r(g); }; }); },
            save: async () => { events.push('save'); return 'backend' as const; }
        };
        const controller = new ProjectArtifactController('proj-x', { id: 'u', displayName: 'U', kind: 'user' }, client as never);
        const init = controller.initialize([], '/root');
        // a change while the load is in flight: persist is asked for at once
        const early = controller.persist();
        await new Promise(r => setTimeout(r, 5));
        expect(events).toEqual(['load asked']);
        finishLoad(createEmptyProjectGraph('proj-x'));
        await Promise.all([init, early]);
        expect(events[1]).toBe('load done');
        expect(events.filter(e => e === 'save').length).toBeGreaterThanOrEqual(2);
        expect(events.indexOf('save')).toBeGreaterThan(events.indexOf('load done'));
    });
});
