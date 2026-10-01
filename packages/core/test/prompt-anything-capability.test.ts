/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    classifyFallbackPrompt,
    synthesizeSandboxFallback,
    synthesize3DFallback,
    synthesizeVideoTimelineFallback,
    synthesizeDefaultDocument
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import {
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptiveKanban,
    synthesizeAdaptiveMetrics,
    synthesizeAdaptiveSandbox
} from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import { LiveCodeSandboxData, Scene3DData, VideoTimelineData, MarkdownDocumentData } from '../src/browser/generative-canvas/canvas-types';

describe('Multi-Modal Prompt-to-Anything Capability Engine', () => {
    describe('1. Code-First Interactive Sandbox Generation', () => {
        it('synthesizes an interactive Web Audio synthesizer from a prompt', () => {
            const prompt = 'Build an interactive 8-bit synthesizer with virtual keyboard keys and audio frequency visualizer';
            const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
            expect(classification.isSandboxRequest).toBe(true);

            const result = synthesizeSandboxFallback(prompt, undefined, []);
            expect(result.artifact).toBeDefined();
            expect(result.artifact?.type).toBe('live-code-sandbox');
            const data = result.artifact?.data as LiveCodeSandboxData;
            const appCode = data.files.find(f => f.name.includes('App') || f.name.includes('index'))?.content || '';
            expect(appCode).toContain('React');
            expect(data.title.toLowerCase()).toMatch(/synthesizer|audio|app|prototype/);
            expect(data.viewMode).toBe('preview');
        });

        it('synthesizes a custom molecular bond simulator from prompt entities', () => {
            const prompt = 'Create an interactive molecular physics sandbox simulating covalent bonds and atomic vibrations';
            const entities = extractPromptEntities(prompt);
            expect(entities.subject).toBeTruthy();
            expect(entities.keywords.length).toBeGreaterThan(0);

            const sandbox = synthesizeAdaptiveSandbox('physics', 'Molecular Physics Simulator', prompt);
            const appCode = sandbox.files.find(f => f.name.includes('App'))?.content || '';
            expect(appCode).toContain('React');
            expect(appCode).toMatch(/Molecule|Physics|Simulation|State|Intensity/i);
            expect(sandbox.files.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('2. Procedural 3D Scene Generation', () => {
        it('synthesizes a 3D Mars rover habitat environment from prompt', () => {
            const prompt = 'Build a 3D procedural Mars rover exploration habitat with red terrain and solar collectors';
            const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
            expect(classification.is3DRequest).toBe(true);

            const result = synthesize3DFallback(prompt, prompt.toLowerCase(), undefined, [], undefined);
            expect(result.artifact).toBeDefined();
            expect(result.artifact?.type).toBe('3d-scene');
            const scene = result.artifact?.data as Scene3DData;
            expect(scene.environment).toBeDefined();
            expect(scene.customMeshes?.length || scene.objects?.length || scene.cppGenerator).toBeTruthy();
        });
    });

    describe('3. Multi-Track Video Timeline NLE Generation', () => {
        it('synthesizes a multi-layer video timeline with chroma keying and color grading', () => {
            const prompt = 'Assemble a multi-track video timeline with green screen chroma keying, color grade, and cyberpunk title overlay';
            const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
            expect(classification.isVideoTimelineRequest).toBe(true);

            const result = synthesizeVideoTimelineFallback(prompt, undefined);
            expect(result.artifact).toBeDefined();
            expect(result.artifact?.type).toBe('video-timeline');
            const timeline = result.artifact?.data as VideoTimelineData;
            expect(timeline.tracks.length).toBeGreaterThanOrEqual(2);
            expect(timeline.duration).toBeGreaterThan(0);
        });
    });

    describe('4. Deep Architectural Spec Document Generation', () => {
        it('synthesizes a comprehensive technical specification with motivated sections', () => {
            const prompt = 'Draft an architecture specification for an autonomous distributed multi-agent swarm';
            const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
            expect(classification.isDocumentRequest).toBe(true);

            const result = synthesizeDefaultDocument(prompt, undefined);
            expect(result.artifact).toBeDefined();
            expect(result.artifact?.type).toBe('markdown-document');
            const doc = result.artifact?.data as MarkdownDocumentData;
            expect(doc.sections.length).toBeGreaterThanOrEqual(4);
            expect(doc.sections.some(s => s.type === 'heading')).toBe(true);
            expect(doc.sections.some(s => s.type === 'checklist')).toBe(true);
        });
    });

    describe('5. Zero-Preset Adaptive Kanban & KPI Telemetry', () => {
        it('synthesizes a domain-adaptive sprint board for aerospace telemetry', () => {
            const prompt = 'Plan an orbital trajectory telemetry system with radar integration and ground station handoff';
            const domain = classifyDomain(prompt);
            const entities = extractPromptEntities(prompt);
            const kanban = synthesizeAdaptiveKanban(prompt, entities, domain);

            expect(kanban.columns.length).toBeGreaterThanOrEqual(3);
            const allCards = kanban.columns.flatMap(c => c.cards);
            expect(allCards.length).toBeGreaterThanOrEqual(3);
            expect(kanban.title).toBeTruthy();
        });

        it('synthesizes quantitative metric cards for real-time quantum computing telemetry', () => {
            const prompt = 'Dashboard for cryogenic dilution refrigerator qubit coherence time and quantum error rates';
            const domain = classifyDomain(prompt);
            const entities = extractPromptEntities(prompt);
            const metrics = synthesizeAdaptiveMetrics(prompt, entities, domain);

            expect(metrics.metrics.length).toBeGreaterThanOrEqual(3);
            expect(metrics.metrics.some(m => m.sparkline && m.sparkline.length > 0)).toBe(true);
            expect(metrics.chart).toBeDefined();
        });
    });
});
