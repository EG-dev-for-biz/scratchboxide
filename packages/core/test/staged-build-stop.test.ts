/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Stop and interruption of a staged build through the REAL useSendMessage (design §6.4, §7.6):
 *  - the StageEvents of a run reach the viewport as they stream (publishStageEvent);
 *  - Stop commits the last artifact with the run marked `stopped` (running and pending stages stopped), and the
 *    overlay shows it on the next render;
 *  - a turn that ends any other way while the run is running (a newer message, a failed stream) marks it
 *    `interrupted` in the active artifact, the history and the session; a finished run is left alone;
 *  - the artifact id survives the end-of-turn commit (no remount);
 *  - in the real viewport (headless Chrome), the stopped artifact shows every committed layer at its end state and the
 *    overlay says "Stopped" after a data update alone.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CanvasArtifact, ChatSession, McpExecutionState } from '../src/browser/generative-canvas/canvas-types';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { ChatRequestError, GeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import { resolveCanvasArtifactId } from '../src/browser/generative-canvas/project-artifact-adapter';
import type { StageEvent, StagedBuildState } from '../src/common/spatial/staged-location-contracts';
import { readStagedBuild, stageEventsFor, subscribeStageEvents } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState';
import { StagedBuildOverlay } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/StagedBuildOverlay';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, FIXTURE_RUN_ID } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';

const COUNTS = Object.fromEntries((['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5', 'l5x'] as const).map(l => [l, { vertices: 3000, triangles: 5000, nodes: 3 }])) as any;
const L = (l: any) => fixtureLayer(l, COUNTS, '/models');

function sceneArtifact(state: StagedBuildState): CanvasArtifact {
    return { id: state.artifactId, type: '3d-scene', title: 'Staged build', summary: '', createdAt: '2026-10-15T12:00:00Z', version: 1, data: stagedSceneData(state) as unknown as CanvasArtifact['data'] };
}

function stageEvent(seq: number, stage: string, status: StageEvent['status'], extra: Partial<StageEvent> = {}): StageEvent {
    return { schema: 'scratchbox.stage-event/2', runId: FIXTURE_RUN_ID, seq, stage, order: 2, status, title: 'Remeshed scan', source: 'tile_refine', degradations: [], timings: { startedAtMs: Date.now(), cached: false }, ...extra };
}

const card = (overrides: Partial<McpExecutionState> = {}): McpExecutionState => ({
    id: 'call-stg', mcpServerId: 'scratchbox-tool-progress', mcpName: 'Scratchbox', toolName: 'google_3d_tiles_get_clay', humanTitle: 'google_3d_tiles_get_clay',
    status: 'running', timestamp: '12:00:00', steps: [{ id: 's1', title: 'Run', status: 'running' }], ...overrides
});

/** A minimal Studio around the real useSendMessage (as chat-stop-and-tool-steps.test.ts builds it). */
function createStudio() {
    const state = {
        sessions: [{ id: 'A', title: 'Chat A', dateCategory: 'Today', updatedAt: 'Just now', messages: [], artifactHistory: [], layoutMode: 'chat' }] as ChatSession[],
        messages: [] as any[], isGenerating: false, activeArtifact: undefined as CanvasArtifact | undefined, artifactHistory: [] as CanvasArtifact[], layoutMode: 'chat' as any, mcpExecutions: [] as McpExecutionState[]
    };
    const set = (key: keyof typeof state) => (value: any) => { (state as any)[key] = typeof value === 'function' ? value((state as any)[key]) : value; };
    const noop = () => undefined;
    const deps = {
        inputValue: '', isGenerating: false, setInputValue: noop, executeDeepWritePipeline: async () => undefined, handleStartAgent: async () => undefined,
        skills: [], selectedSkillIds: [], mcpServers: [], selectedMcpIds: [], currentSessionId: 'A', setCurrentSessionId: noop,
        sessions: state.sessions, setSessions: set('sessions'), messages: [], setMessages: set('messages'), setAutocompleteType: noop,
        setIsGenerating: set('isGenerating'), setLiveThinkingText: noop, setLiveThinkingSeconds: noop, setLiveSteps: noop, setLiveStreamedText: noop,
        setActiveStreamingSectionId: noop, liveThinkingText: '', liveThinkingSeconds: 0, liveSteps: [], activeSessionRef: { current: 'A' },
        googleSearchGrounding: false, activeArtifact: undefined, setActiveArtifact: set('activeArtifact'), artifactHistory: [], setArtifactHistory: set('artifactHistory'),
        layoutMode: 'chat', setLayoutMode: set('layoutMode'), setMcpExecutions: set('mcpExecutions'), setTokenBudget: noop, setActiveTerminalError: noop,
        setShowTerminalErrorToast: noop, recordArtifactVersion: noop, attachedDataFile: undefined, setAttachedDataFile: noop, showToast: noop,
        graphControllerRef: { current: { registerArtifact: (a: CanvasArtifact) => a } as unknown as ProjectArtifactController }, setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem, persistSessionsImmediately: noop, aiInteractionMode: 'agent'
    } as unknown as SendMessageDeps;
    let hook: UseSendMessageResult | undefined;
    const Harness = () => { hook = useSendMessage(deps); return null; };
    renderToStaticMarkup(React.createElement(Harness));
    return { state, hook: hook! };
}

type Script = (emit: (event: GeminiStreamEvent) => void, signal: AbortSignal | undefined) => Promise<void>;
function scriptStreams(...scripts: Script[]): void {
    vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
    vi.spyOn(GeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (_request, onEvent, signal) => {
        const script = scripts.shift();
        if (!script) throw new Error('no scripted stream left');
        await script(onEvent, signal);
    });
}
const untilAborted = (signal: AbortSignal | undefined) => new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** The stream of a staged run up to the remesh running: tiles committed (with the artifact), remesh running (event only). */
async function streamUntilRemeshRunning(emit: (e: GeminiStreamEvent) => void): Promise<void> {
    const committed = fixtureState([L('l1')], { running: ['remesh'] });
    emit({ type: 'status', text: 'google_3d_tiles_get_clay: Google 3D Tiles — committed', mcpExecution: card(), artifact: sceneArtifact(committed), stageEvent: stageEvent(1, 'tiles', 'committed', { title: 'Google 3D Tiles', order: 1, layers: [L('l1')] }) } as GeminiStreamEvent);
    emit({ type: 'status', text: 'google_3d_tiles_get_clay: Remeshed scan — running', mcpExecution: card(), stageEvent: stageEvent(2, 'remesh', 'running', { progress: 0.3, message: 'rectifying facades' }) } as GeminiStreamEvent);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Stop and interruption through the real useSendMessage', () => {
    test('streamed StageEvents reach the viewport; Stop commits the run as stopped and the overlay says so', async () => {
        const studio = createStudio();
        const seen: number[] = [];
        const off = subscribeStageEvents(e => { if (e.runId === FIXTURE_RUN_ID) seen.push(e.seq); });
        const streamed = deferred();
        scriptStreams(async (emit, signal) => {
            await streamUntilRemeshRunning(emit);
            streamed.resolve();
            await untilAborted(signal);
        });
        const sending = studio.hook.sendMessage('the arch in clay, staged');
        await streamed.promise;
        expect(seen).toEqual([1, 2]);
        expect(stageEventsFor(FIXTURE_RUN_ID).map(e => e.status)).toEqual(['committed', 'running']);
        expect(readStagedBuild(studio.state.activeArtifact!.data as never)!.runState).toBe('running');
        studio.hook.cancelInFlight();
        await sending;
        off();

        const reply = studio.state.sessions[0].messages.at(-1)!;
        const stopped = readStagedBuild(reply.artifacts![0].data as never)!;
        expect(stopped.runState).toBe('stopped');
        expect(stopped.stages.find(s => s.stage === 'remesh')!.status).toBe('stopped');
        expect(stopped.stages.find(s => s.stage === 'tiles')!.status).toBe('committed');
        expect(readStagedBuild(studio.state.activeArtifact!.data as never)!.runState).toBe('stopped');
        expect(readStagedBuild(studio.state.sessions[0].activeArtifact!.data as never)!.runState).toBe('stopped');
        // The id survives the end-of-turn commit: no re-key, so the viewport is not remounted.
        expect(reply.artifacts![0].id).toBe(`scene-stg-${FIXTURE_RUN_ID}`);
        expect(resolveCanvasArtifactId('project-1', reply.artifacts![0])).toBe(`scene-stg-${FIXTURE_RUN_ID}`);
        // The overlay on the next render.
        const html = renderToStaticMarkup(React.createElement(StagedBuildOverlay, {
            state: stopped, interrupted: false, layers: [], progress: new Map(), nowMs: 0, wallNowMs: Date.now(), announcement: '', provenanceOn: false,
            onToggleProvenance: () => undefined, legend: [], showReplaced: false, onToggleShowReplaced: () => undefined, onReplay: () => undefined,
            onRetry: () => undefined, onHighlight: () => undefined, bottomInsetPx: 16
        }));
        expect(html).toContain('■ Remeshed scan stopped');
        expect(html).toContain('Stopped. Google 3D Tiles stay in the scene.');
    });

    test('a newer message aborting the turn marks the running run interrupted', async () => {
        const studio = createStudio();
        const streamed = deferred();
        scriptStreams(async (emit, signal) => {
            await streamUntilRemeshRunning(emit);
            streamed.resolve();
            await untilAborted(signal);
        }, async () => undefined);
        const first = studio.hook.sendMessage('the arch in clay, staged');
        await streamed.promise;
        const second = studio.hook.sendMessage('actually, something else');
        await first;
        await second;
        const s = readStagedBuild(studio.state.sessions[0].activeArtifact!.data as never) ?? readStagedBuild(studio.state.activeArtifact!.data as never);
        expect(s!.runState).toBe('interrupted');
        expect(s!.stages.find(x => x.stage === 'remesh')!.status).toBe('stopped');
    });

    test('a failed stream marks it interrupted; a finished run is left alone', async () => {
        const studio = createStudio();
        scriptStreams(async emit => {
            await streamUntilRemeshRunning(emit);
            throw new ChatRequestError('AI request failed (500): {"error":{"code":500,"message":"Internal error."}}', 'ai');
        });
        await studio.hook.sendMessage('the arch in clay, staged');
        expect(readStagedBuild(studio.state.activeArtifact!.data as never)!.runState).toBe('interrupted');

        const done = createStudio();
        const finished = fixtureState([L('l1'), L('l2')], { runState: 'finished' });
        scriptStreams(async emit => {
            emit({ type: 'status', mcpExecution: card({ status: 'completed', summaryResult: 'Staged build complete' }), artifact: sceneArtifact(finished) } as GeminiStreamEvent);
            emit({ type: 'delta', text: 'The arch is in the scene.' });
        });
        await done.hook.sendMessage('the arch in clay, staged');
        expect(readStagedBuild(done.state.activeArtifact!.data as never)!.runState).toBe('finished');
    });
});

describe.skipIf(!stagedChrome.ok)('the stopped artifact in the real viewport', () => {
    test('a data update alone shows every committed layer at its end state and the overlay says Stopped', async () => {
        const fixture = buildStagedFixture();
        const LL = (l: any) => fixtureLayer(l, fixture.counts, '/models');
        const page = await openStagedPage({ manualFrames: true });
        try {
            serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
            const running = fixtureState([LL('l1'), LL('l2')], { running: ['fit'] });
            await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(running))})`);
            for (const l of ['l1', 'l2']) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
            // Mid-reveal of the remesh crossfade, then Stop arrives as a data update.
            for (let i = 0; i < 400; i++) {
                const f = await page.eval<{ phase: string } | null>(`sbHarness.layer(${JSON.stringify(objectIdOf('l2'))})`);
                if (f?.phase === 'revealing') break;
                await page.step(1, 16);
            }
            const art = sceneArtifact(running);
            const { markStagedRun } = await import('../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState');
            const stoppedArt = markStagedRun(art, 'stopped');
            await page.eval(`sbHarness.update(${JSON.stringify(stoppedArt.data)})`);
            await page.step(2, 16);
            expect((await page.eval<{ phase: string }>(`sbHarness.layer(${JSON.stringify(objectIdOf('l2'))})`)).phase).toBe('revealed');
            expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-runstate"]')`)).toMatch(/^Stopped\./);
            await page.screenshot('stop_after_remesh_data_update');
        } finally {
            await page.close();
        }
    });
});
