/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptiveResearchBrief
} from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import {
    classifyFallbackPrompt,
    synthesizeChatFallback
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { cleanMessageTextSmart } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { rasterizeChatMarkdownToScreenshot } from './helpers/test-screenshot-helper';

describe('Adaptive Domain Architecture (ADA) - Conversational Chat Synthesis', () => {
    describe('1. Open-Domain Adaptive Research Synthesis (Zero-Preset)', () => {
        it('synthesizes rich, domain-grounded research brief for novel quantum physics topic', () => {
            const prompt = 'Explain the principles of topological quantum computing and Majorana zero modes';
            const brief = synthesizeAdaptiveResearchBrief('technology', prompt);

            expect(brief).toContain('Topological Quantum Computing');
            expect(brief).toMatch(/Theoretical Foundations|Core Principles|Mechanisms/i);
            expect(brief).toMatch(/Empirical Specifications|Parameters|Architecture/i);
            expect(brief).toMatch(/Critical Considerations|Trade-Offs|Limits|Failure Modes/i);
            expect(brief).toMatch(/Actionable Canvas Primitives|Proactive Canvas/i);

            const shot = rasterizeChatMarkdownToScreenshot('adaptive_chat_quantum_computing_brief', brief);
            expect(fs.existsSync(shot)).toBe(true);
        });

        it('synthesizes rich research brief for novel biological engineering topic', () => {
            const prompt = 'How does CRISPR prime editing differ from base editing in genomic medicine?';
            const brief = synthesizeAdaptiveResearchBrief('biology', prompt);

            expect(brief).toMatch(/CRISPR Prime Editing|Genomic Medicine/i);
            expect(brief).toMatch(/Theoretical Foundations|Mechanisms/i);
            expect(brief).toMatch(/Actionable Canvas/i);

            const shot = rasterizeChatMarkdownToScreenshot('adaptive_chat_crispr_genomics_brief', brief);
            expect(fs.existsSync(shot)).toBe(true);
        });

        it('synthesizes rich research brief for novel historical & humanities inquiry', () => {
            const prompt = 'What were the logistical supply lines and grain supply networks of the Roman Empire?';
            const brief = synthesizeAdaptiveResearchBrief('history', prompt);

            expect(brief).toMatch(/Logistical Supply Lines|Grain Supply Networks/i);
            expect(brief).toMatch(/Chronology|Foundations|Mechanisms/i);

            const shot = rasterizeChatMarkdownToScreenshot('adaptive_chat_roman_supply_networks_brief', brief);
            expect(fs.existsSync(shot)).toBe(true);
        });

        it('passes the Alien Planet Test: generates deep brief for an unconceived novel domain', () => {
            const prompt = 'Describe the geothermal mycelium biome inside a hollow carbonaceous asteroid';
            const brief = synthesizeAdaptiveResearchBrief('general', prompt);

            expect(brief).toMatch(/Geothermal Mycelium Biome|Carbonaceous Asteroid/i);
            expect(brief).toMatch(/Theoretical Foundations|Mechanisms/i);
            expect(brief).not.toContain("I'm here to help! Whether you're exploring scientific research, writing code");

            const shot = rasterizeChatMarkdownToScreenshot('adaptive_chat_alien_planet_mycelium_brief', brief);
            expect(fs.existsSync(shot)).toBe(true);
        });
    });

    describe('2. synthesizeChatFallback ADA Integration', () => {
        it('returns structured research markdown for general inquiries without collapsing to 4-line boilerplate', () => {
            const prompt = 'Analyze the thermodynamic efficiency of molten salt nuclear reactors';
            const result = synthesizeChatFallback(prompt);

            expect(result.chatResponse).toBeDefined();
            expect(result.chatResponse!.length).toBeGreaterThan(300);
            expect(result.chatResponse).toMatch(/Molten Salt Nuclear Reactors|Thermodynamic Efficiency/i);
            expect(result.chatResponse).toMatch(/Foundations|Mechanics/i);
            expect(result.chatResponse).not.toContain("I'm here to help! Whether you're exploring scientific research, writing code");

            const shot = rasterizeChatMarkdownToScreenshot('adaptive_chat_molten_salt_fallback', result.chatResponse!);
            expect(fs.existsSync(shot)).toBe(true);
        });

        it('delegates explicit 3D vehicle or spatial fabrication directives to 3D synthesis', () => {
            const prompt = 'Build a 3D model of a cyber sports car';
            const result = synthesizeChatFallback(prompt);

            expect(result.artifact).toBeDefined();
            expect(result.artifact?.type).toBe('3d-scene');
        });
    });

    describe('3. Conversational vs Spatial Intent Gating (No False Hijacking)', () => {
        it('treats pure landmark historical questions as chat, not 3D scene replacement', () => {
            const active3DScene: CanvasArtifact = {
                id: 'art-3d-test',
                type: '3d-scene',
                title: 'Urban Viewport',
                summary: 'Active 3D scene',
                data: { title: 'Urban Viewport' } as Scene3DData
            };

            const conversationalPrompt = 'What is the architectural history and construction timeline of the Colosseum?';
            const classification = classifyFallbackPrompt(conversationalPrompt, undefined, '3d', active3DScene);

            expect(classification.isChatIntent).toBe(true);
            expect(classification.is3DRequest).toBe(false);
        });

        it('treats geological/material questions as chat, not 3D scene replacement', () => {
            const active3DScene: CanvasArtifact = {
                id: 'art-3d-test',
                type: '3d-scene',
                title: 'Landscape Viewport',
                summary: 'Active 3D scene',
                data: { title: 'Landscape Viewport' } as Scene3DData
            };

            const conversationalPrompt = 'Why is travertine stone porous and where does it naturally form?';
            const classification = classifyFallbackPrompt(conversationalPrompt, undefined, '3d', active3DScene);

            expect(classification.isChatIntent).toBe(true);
            expect(classification.is3DRequest).toBe(false);
        });

        it('correctly classifies explicit 3D mutation directives as 3D request', () => {
            const active3DScene: CanvasArtifact = {
                id: 'art-3d-test',
                type: '3d-scene',
                title: 'Colosseum Viewport',
                summary: 'Active 3D scene',
                data: { title: 'Colosseum Viewport' } as Scene3DData
            };

            const mutationPrompt = 'Switch the lighting to golden hour and enable volumetric god rays';
            const classification = classifyFallbackPrompt(mutationPrompt, undefined, '3d', active3DScene);

            expect(classification.is3DRequest).toBe(true);
        });
    });

    describe('4. Message Cleaning & Chat Cleanliness', () => {
        it('cleanMessageTextSmart preserves rich conversational responses untouched', () => {
            const sampleChat = `# 🌌 Comprehensive Research Analysis: Quantum Hall Effect\n\n### 1. Theoretical Foundations\nThe Quantum Hall Effect represents a topological phase of matter.`;
            const cleaned = cleanMessageTextSmart(sampleChat);

            expect(cleaned).toContain('Quantum Hall Effect');
            expect(cleaned).toContain('Theoretical Foundations');
        });
    });
});
