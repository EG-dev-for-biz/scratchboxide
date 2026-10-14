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
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptiveKanban,
    synthesizeAdaptiveMetrics,
    synthesizeAdaptiveSandbox
} from '../src/browser/generative-canvas/services/adaptive-domain-engine';

describe('Multi-Modal Prompt-to-Anything Capability Engine', () => {
    describe('1. Code-First Interactive Sandbox Generation', () => {
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
