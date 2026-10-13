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
    buildExtractPalettePrompt,
    parseExtractedPalette,
    buildApplyPalettePrompt,
    formatPaletteAsMarkdown,
    executeTwoStepColorTransfer,
    NanoBananaColorService,
    type ExtractedColorPalette
} from '../src/browser/generative-canvas/services/nano-banana-color-service';
import {
    NANO_BANANA_TOOL_DECLARATIONS,
    nanoBananaHandlers
} from '../src/node/gemini/tools/nano-banana-tools';
import {
    createDefaultToolRegistry,
    inferToolGroup,
    buildToolDeclarations
} from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('Nano Banana Method 2: Two-Step Color Transfer Service', () => {

    describe('Phase 1: Palette & Lighting Extraction Prompt Builder', () => {
        it('builds global extraction prompt with strict optical schema', () => {
            const prompt = buildExtractPalettePrompt();
            expect(prompt).toContain('Analyze this image and extract its complete color palette');
            expect(prompt).toContain('across the entire global frame');
            expect(prompt).toContain('PRIMARY_TONES');
            expect(prompt).toContain('ACCENT_TONES');
            expect(prompt).toContain('SHADOW_PROFILE');
            expect(prompt).toContain('HIGHLIGHT_PROFILE');
            expect(prompt).toContain('LIGHTING_ATMOSPHERE');
            expect(prompt).toContain('Output clean structured JSON');
        });

        it('supports targeted focus areas for extraction', () => {
            const promptBg = buildExtractPalettePrompt({ focusArea: 'background' });
            expect(promptBg).toContain('concentrating specifically on the background');

            const promptSubject = buildExtractPalettePrompt({ focusArea: 'subject' });
            expect(promptSubject).toContain('concentrating specifically on the subject');
        });
    });

    describe('Palette Parser (parseExtractedPalette)', () => {
        it('parses valid structured JSON code block', () => {
            const sampleJson = `
\`\`\`json
{
  "primaryTones": [
    { "name": "Prussian Night", "hex": "#0B192C", "role": "Dominant Deep", "percentage": 50 },
    { "name": "Terracotta Sand", "hex": "#D97706", "role": "Warm Architecture", "percentage": 30 }
  ],
  "accentTones": [
    { "name": "Electric Azure", "hex": "#0284C7", "role": "Rim Highlight", "percentage": 10 }
  ],
  "shadowProfile": {
    "tone": "Deep teal shadow cast",
    "temperature": "cool",
    "hex": "#0F172A"
  },
  "highlightProfile": {
    "tone": "Warm golden raking light",
    "temperature": "warm",
    "hex": "#FEF3C7"
  },
  "lightingAtmosphere": "Dramatic dusk with high contrast between glowing warm lights and deep cool shadows",
  "contrastProfile": "cinematic",
  "rawSummary": "Sample dusk palette"
}
\`\`\`
            `;

            const palette = parseExtractedPalette(sampleJson);
            expect(palette.primaryTones.length).toBe(2);
            expect(palette.primaryTones[0].hex).toBe('#0B192C');
            expect(palette.accentTones[0].hex).toBe('#0284C7');
            expect(palette.shadowProfile.temperature).toBe('cool');
            expect(palette.highlightProfile.temperature).toBe('warm');
            expect(palette.contrastProfile).toBe('cinematic');
        });

        it('parses unstructured Markdown text with hex codes as heuristic fallback', () => {
            const markdownText = `
                Extracted colors from reference scene:
                The background is filled with rich blue #1E3A8A and deep navy #0F172A.
                The accents feature glowing amber #F59E0B and gold #EAB308.
                Shadows have cool blue undertones while highlights show warm afternoon sun.
                Atmospheric lighting is moody with rich natural contrast.
            `;

            const palette = parseExtractedPalette(markdownText);
            expect(palette.primaryTones.length).toBeGreaterThan(0);
            expect(palette.shadowProfile.temperature).toBe('cool');
            expect(palette.highlightProfile.temperature).toBe('warm');
        });

        it('returns fallback palette on empty or invalid text', () => {
            const fallback = parseExtractedPalette('');
            expect(fallback.primaryTones.length).toBeGreaterThan(0);
            expect(fallback.shadowProfile).toBeDefined();
            expect(fallback.highlightProfile).toBeDefined();
        });
    });

    describe('Phase 2: Palette Application Prompt Builder (Geometry Locking & Global Override)', () => {
        const testPalette: ExtractedColorPalette = {
            primaryTones: [
                { name: 'Obsidian Black', hex: '#0A0A0A', role: 'Dominant Background' },
                { name: 'Copper Rust', hex: '#B45309', role: 'Midtone Surface' }
            ],
            accentTones: [
                { name: 'Neon Emerald', hex: '#10B981', role: 'Specular Rim' }
            ],
            shadowProfile: { tone: 'Cold charcoal', temperature: 'cool', hex: '#18181B' },
            highlightProfile: { tone: 'Warm candlelight', temperature: 'warm', hex: '#FEF08A' },
            lightingAtmosphere: 'Chiaroscuro moody interior',
            contrastProfile: 'high-contrast',
            rawSummary: 'High contrast copper emerald palette'
        };

        it('enforces non-negotiable geometry locking and global color override', () => {
            const prompt = buildApplyPalettePrompt({
                targetImageUrl: 'https://example.com/target_architecture.jpg',
                palette: testPalette,
                aspectRatio: '16:9'
            });

            expect(prompt).toContain('GLOBAL COLOR OVERRIDE');
            expect(prompt).toContain('CRITICAL GEOMETRY & STRUCTURAL LOCKING — NON-NEGOTIABLE');
            expect(prompt).toContain('Preserve the exact 100% identical composition, perspective, camera angle');
            expect(prompt).toContain('Keep all objects, characters, buildings, outlines, silhouettes');
            expect(prompt).toContain('do NOT pan, zoom, crop, warp, recompose');
            expect(prompt).toContain('Completely discard and ignore the target image\'s original color values');
            expect(prompt).toContain('Obsidian Black (#0A0A0A');
            expect(prompt).toContain('Neon Emerald (#10B981');
            expect(prompt).toContain('Canvas Aspect Ratio: Strictly maintain 16:9.');
        });

        it('injects human skin tone protection rule when preserveSkinTones is true', () => {
            const promptWithSkin = buildApplyPalettePrompt({
                targetImageUrl: 'https://example.com/portrait.jpg',
                palette: testPalette,
                preserveSkinTones: true
            });

            expect(promptWithSkin).toContain('EXCEPTION FOR HUMAN SUBJECTS: Preserve natural human skin tones');

            const promptWithoutSkin = buildApplyPalettePrompt({
                targetImageUrl: 'https://example.com/portrait.jpg',
                palette: testPalette,
                preserveSkinTones: false
            });

            expect(promptWithoutSkin).not.toContain('EXCEPTION FOR HUMAN SUBJECTS');
        });

        it('applies custom contrast curves and saturation multipliers', () => {
            const prompt = buildApplyPalettePrompt({
                targetImageUrl: 'https://example.com/target.jpg',
                palette: testPalette,
                contrastCurve: 'muted',
                saturationMultiplier: 1.25,
                targetFocusArea: 'background foliage only'
            });

            expect(prompt).toContain('specifically targeting the background foliage only');
            expect(prompt).toContain('Apply low-contrast muted grading');
            expect(prompt).toContain('Apply a saturation scaling factor of 1.25x');
        });
    });

    describe('Markdown Palette Formatting', () => {
        it('formats rich Markdown table with badges and categories', () => {
            const palette: ExtractedColorPalette = {
                primaryTones: [{ name: 'Deep Indigo', hex: '#312E81', role: 'Ambient' }],
                accentTones: [{ name: 'Amber Glow', hex: '#F59E0B', role: 'Focal' }],
                shadowProfile: { tone: 'Indigo Shadow', temperature: 'cool', hex: '#1E1B4B' },
                highlightProfile: { tone: 'Warm Sun', temperature: 'warm', hex: '#FFFBEB' },
                lightingAtmosphere: 'Twilight dusk',
                rawSummary: 'Indigo amber'
            };

            const md = formatPaletteAsMarkdown(palette);
            expect(md).toContain('### 🎨 Extracted Nano Banana Color Palette & Lighting DNA');
            expect(md).toContain('| **Primary Base** | Deep Indigo | `#312E81` |');
            expect(md).toContain('| **Accent** | Amber Glow | `#F59E0B` |');
            expect(md).toContain('`#1E1B4B`');
            expect(md).toContain('COOL');
        });
    });

    describe('End-to-End Orchestration (executeTwoStepColorTransfer)', () => {
        it('orchestrates complete transfer plan with telemetry', () => {
            const plan = executeTwoStepColorTransfer({
                referenceImage: 'models/reference_look.jpg',
                targetImage: 'models/target_mesh_render.png',
                preserveSkinTones: true,
                contrastCurve: 'cinematic',
                aspectRatio: '16:9'
            });

            expect(plan.success).toBe(true);
            expect(plan.phase1ExtractionPrompt).toContain('Analyze this image and extract its complete color palette');
            expect(plan.extractedPalette.primaryTones.length).toBeGreaterThan(0);
            expect(plan.phase2ApplicationPrompt).toContain('GLOBAL COLOR OVERRIDE');
            expect(plan.phase2ApplicationPrompt).toContain('CRITICAL GEOMETRY & STRUCTURAL LOCKING');
            expect(plan.phase2ApplicationPrompt).toContain('EXCEPTION FOR HUMAN SUBJECTS');
            expect(plan.telemetry.geometryLocked).toBe(true);
            expect(plan.telemetry.globalColorOverride).toBe(true);
            expect(plan.telemetry.referenceImage).toBe('models/reference_look.jpg');
            expect(plan.telemetry.targetImage).toBe('models/target_mesh_render.png');
        });

        it('NanoBananaColorService facade exposes all methods', () => {
            expect(typeof NanoBananaColorService.buildExtractPalettePrompt).toBe('function');
            expect(typeof NanoBananaColorService.parseExtractedPalette).toBe('function');
            expect(typeof NanoBananaColorService.buildApplyPalettePrompt).toBe('function');
            expect(typeof NanoBananaColorService.formatPaletteAsMarkdown).toBe('function');
            expect(typeof NanoBananaColorService.transferColor).toBe('function');
        });
    });

    describe('Gemini Agent Tools & Registry Integration', () => {
        it('defines all 3 Nano Banana tools with proper schema properties', () => {
            expect(NANO_BANANA_TOOL_DECLARATIONS.length).toBe(3);

            const extractTool = NANO_BANANA_TOOL_DECLARATIONS.find(t => t.name === 'nano_banana_extract_color_palette');
            expect(extractTool).toBeDefined();
            expect(extractTool?.parameters.required).toContain('referenceImageUrl');

            const applyTool = NANO_BANANA_TOOL_DECLARATIONS.find(t => t.name === 'nano_banana_apply_color_palette');
            expect(applyTool).toBeDefined();
            expect(applyTool?.parameters.required).toContain('targetImageUrl');
            expect(applyTool?.parameters.required).toContain('palette');

            const transferTool = NANO_BANANA_TOOL_DECLARATIONS.find(t => t.name === 'nano_banana_transfer_color');
            expect(transferTool).toBeDefined();
            expect(transferTool?.parameters.required).toContain('referenceImageUrl');
            expect(transferTool?.parameters.required).toContain('targetImageUrl');
        });

        it('infers tool group as "workspace" for all nano_banana_* tools', () => {
            expect(inferToolGroup('nano_banana_extract_color_palette')).toBe('workspace');
            expect(inferToolGroup('nano_banana_apply_color_palette')).toBe('workspace');
            expect(inferToolGroup('nano_banana_transfer_color')).toBe('workspace');
        });

        it('registers tools in createDefaultToolRegistry and executes dispatch', async () => {
            const registry = createDefaultToolRegistry();

            // 1. Dispatch extraction tool
            const extractOutcome = await registry.dispatch('nano_banana_extract_color_palette', {
                referenceImageUrl: 'https://example.com/reference.jpg',
                focusArea: 'global'
            }, {} as any);

            expect(extractOutcome.exec.status).toBe('completed');
            expect((extractOutcome.resultPayload as any).success).toBe(true);
            expect((extractOutcome.resultPayload as any).palette).toBeDefined();
            expect((extractOutcome.resultPayload as any).markdownSwatches).toBeDefined();

            // 2. Dispatch application tool
            const applyOutcome = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: 'https://example.com/target.jpg',
                palette: (extractOutcome.resultPayload as any).palette,
                preserveSkinTones: true,
                contrastCurve: 'cinematic',
                aspectRatio: '16:9'
            }, {} as any);

            expect(applyOutcome.exec.status).toBe('completed');
            expect((applyOutcome.resultPayload as any).success).toBe(true);
            expect((applyOutcome.resultPayload as any).geometryLocked).toBe(true);
            expect((applyOutcome.resultPayload as any).applicationPrompt).toContain('GLOBAL COLOR OVERRIDE');

            // 3. Dispatch end-to-end transfer tool
            const transferOutcome = await registry.dispatch('nano_banana_transfer_color', {
                referenceImageUrl: 'https://example.com/palette_ref.jpg',
                targetImageUrl: 'https://example.com/lineart_target.png',
                preserveSkinTones: false,
                contrastCurve: 'high-contrast'
            }, {} as any);

            expect(transferOutcome.exec.status).toBe('completed');
            expect((transferOutcome.resultPayload as any).success).toBe(true);
            expect((transferOutcome.resultPayload as any).telemetry.geometryLocked).toBe(true);
        });

        it('validates required arguments and throws informative errors', async () => {
            const registry = createDefaultToolRegistry();

            const failExtract = await registry.dispatch('nano_banana_extract_color_palette', {}, {} as any);
            expect(failExtract.exec.status).toBe('failed');
            expect(failExtract.resultPayload.error).toContain('referenceImageUrl');

            const failApply = await registry.dispatch('nano_banana_apply_color_palette', { targetImageUrl: 'test.jpg' }, {} as any);
            expect(failApply.exec.status).toBe('failed');
            expect(failApply.resultPayload.error).toContain('palette');
        });

        it('buildToolDeclarations dynamically includes nano_banana tools on color transfer prompts', () => {
            const registry = createDefaultToolRegistry();

            const configs = buildToolDeclarations({
                prompt: 'Please extract color palette from reference.jpg and transfer color to target.png using nano banana'
            }, registry);

            const funcDecls = configs?.flatMap(c => c.functionDeclarations || []) || [];
            expect(funcDecls.some(d => d.name === 'nano_banana_extract_color_palette')).toBe(true);
            expect(funcDecls.some(d => d.name === 'nano_banana_apply_color_palette')).toBe(true);
            expect(funcDecls.some(d => d.name === 'nano_banana_transfer_color')).toBe(true);
        });
    });

    describe('Task Capability Resolver Integration', () => {
        it('resolves Nano Banana color transfer requests natively to Tier 1', () => {
            const resolution = TaskCapabilityResolver.resolveTaskCapability(
                'Extract and apply color from reference image to target image using nano banana method 2'
            );

            expect(resolution.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
            expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('Nano Banana Color Transfer Pipeline'))).toBe(true);
            expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('nano_banana_transfer_color');
        });
    });
});
