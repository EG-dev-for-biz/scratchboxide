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
import { cleanMessageTextSmart } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
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

    describe('4. Message Cleaning & Chat Cleanliness', () => {
        it('cleanMessageTextSmart preserves rich conversational responses untouched', () => {
            const sampleChat = `# 🌌 Comprehensive Research Analysis: Quantum Hall Effect\n\n### 1. Theoretical Foundations\nThe Quantum Hall Effect represents a topological phase of matter.`;
            const cleaned = cleanMessageTextSmart(sampleChat);

            expect(cleaned).toContain('Quantum Hall Effect');
            expect(cleaned).toContain('Theoretical Foundations');
        });
    });
});
