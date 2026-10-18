/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { encodePng } from '../src/node/texture-processing';
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
import { MissingInputError } from '../src/common/errors/pipeline-errors';

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

        it('keeps a temperature in the model\'s own words instead of forcing it into warm/cool/neutral', () => {
            const palette = parseExtractedPalette(JSON.stringify({
                primaryTones: [{ name: 'Basalt', hex: '2B2D30' }],
                accentTones: [{ name: 'Sodium Lamp', hex: '#f5a623' }],
                shadowProfile: { tone: 'Blue-black', temperature: 'cool-neutral' },
                highlightProfile: { tone: 'Sodium glare', temperature: '2000K' },
                lightingAtmosphere: 'Night street under sodium lamps'
            }));
            expect(palette.shadowProfile.temperature).toBe('cool-neutral');
            expect(palette.highlightProfile.temperature).toBe('2000K');
            expect(palette.primaryTones[0].hex).toBe('#2B2D30');
            expect(palette.accentTones[0].hex).toBe('#F5A623');
            expect(palette.contrastProfile).toBeUndefined();
            expect(buildApplyPalettePrompt({ palette })).toContain('Sodium glare (2000K temperature)');
        });

        it('refuses prose, an empty answer or an incomplete palette instead of guessing colours or using stock ones', () => {
            const prose = `The background is rich blue #1E3A8A and deep navy #0F172A; accents glow amber #F59E0B.
                Shadows have cool blue undertones while highlights show warm afternoon sun.`;
            expect(() => parseExtractedPalette(prose)).toThrow(MissingInputError);
            expect(() => parseExtractedPalette('')).toThrow('the answer is empty');
            expect(() => parseExtractedPalette('```json\n{"primaryTones":[{"name":"A","hex":"#111111"}],"accentTones":[],"shadowProfile":{"tone":"x","temperature":"cool"},"highlightProfile":{"tone":"y","temperature":"warm"},"lightingAtmosphere":"z"}\n```'))
                .toThrow('palette.accentTones');
            expect(() => parseExtractedPalette(JSON.stringify({
                primaryTones: [{ name: 'A', hex: '#111111' }], accentTones: [{ name: 'B', hex: '#222222' }],
                shadowProfile: { tone: 'x' }, highlightProfile: { tone: 'y', temperature: 'warm' }, lightingAtmosphere: 'z'
            }))).toThrow('palette.shadowProfile');
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

        it('adds no ratio or contrast of its own: without them the prompt keeps the target\'s ratio, and other curve names are used as written', () => {
            const plain = buildApplyPalettePrompt({ palette: { ...testPalette, contrastProfile: undefined } });
            expect(plain).toContain('Keep the target image\'s own aspect ratio.');
            expect(plain).not.toContain('16:9');
            expect(plain).not.toContain('contrast curve');
            expect(plain).not.toContain('contrast grading');
            const own = buildApplyPalettePrompt({ palette: testPalette, contrastCurve: 'bleach-bypass' });
            expect(own).toContain('Apply bleach-bypass contrast grading.');
            expect(() => buildApplyPalettePrompt({ palette: { ...testPalette, primaryTones: [] } })).toThrow('palette.primaryTones');
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
            expect(md).toContain('| Shadow / AO | cool |');
            expect(md).not.toContain('Contrast Profile');
        });
    });

    describe('End-to-End Orchestration (executeTwoStepColorTransfer)', () => {
        const readPalette = JSON.stringify({
            primaryTones: [{ name: 'Harbour Grey', hex: '#5B6670' }],
            accentTones: [{ name: 'Buoy Orange', hex: '#E8590C' }],
            shadowProfile: { tone: 'Slate shadow', temperature: 'cool' },
            highlightProfile: { tone: 'Hazy sun', temperature: 'neutral-warm' },
            lightingAtmosphere: 'Hazy coastal afternoon'
        });

        it('builds the plan from the palette the extraction model read, and refuses to plan without one', () => {
            expect(() => executeTwoStepColorTransfer({ referenceImage: 'a.jpg', targetImage: 'b.png' } as any)).toThrow(MissingInputError);
            const plan = executeTwoStepColorTransfer({
                referenceImage: 'models/reference_look.jpg',
                targetImage: 'models/target_mesh_render.png',
                extractedPalette: '```json\n' + readPalette + '\n```',
                preserveSkinTones: true,
                contrastCurve: 'cinematic',
                aspectRatio: '16:9'
            });

            expect(plan.success).toBe(true);
            expect(plan.phase1ExtractionPrompt).toContain('Analyze this image and extract its complete color palette');
            expect(plan.extractedPalette.primaryTones.map(t => t.hex)).toEqual(['#5B6670']);
            expect(plan.phase2ApplicationPrompt).toContain('Buoy Orange (#E8590C');
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
        // No test reaches a real model: the media client is a fake that answers a fixed recolored PNG.
        const modelPng = encodePng(8, 6, Buffer.alloc(8 * 6 * 4, 77));
        let tmpDir: string;
        let targetPath: string;
        let requests: any[];
        beforeEach(async () => {
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb_palette_'));
            targetPath = path.join(tmpDir, 'target.png');
            await fs.writeFile(targetPath, encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 200)));
            requests = [];
            vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue({
                models: {
                    generateContent: async (req: any) => {
                        requests.push(req);
                        return { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: modelPng.toString('base64'), mimeType: 'image/png' } }] } }] };
                    }
                }
            } as any);
        });
        afterEach(async () => {
            vi.restoreAllMocks();
            await fs.remove(tmpDir);
        });

        const completePalette: ExtractedColorPalette = {
            primaryTones: [{ name: 'Fjord Slate', hex: '#3A4A5C', role: 'Ambient' }],
            accentTones: [{ name: 'Lichen Ochre', hex: '#B8952E', role: 'Specular' }],
            shadowProfile: { tone: 'Blue-grey shadow', temperature: 'cool', hex: '#1C2430' },
            highlightProfile: { tone: 'Pale morning light', temperature: 'warm', hex: '#F2E6C9' },
            lightingAtmosphere: 'Overcast northern morning with soft directional light',
            rawSummary: ''
        };

        it('offers only the palette application tool: the extract and transfer tools returned a stock palette for any image', () => {
            expect(NANO_BANANA_TOOL_DECLARATIONS.map(t => t.name)).toEqual(['nano_banana_apply_color_palette']);
            const applyTool = NANO_BANANA_TOOL_DECLARATIONS[0];
            expect(applyTool.parameters.required).toContain('targetImageUrl');
            expect(applyTool.parameters.required).toContain('palette');
            expect(applyTool.description).toContain('Writes the edited image to disk');
            expect(inferToolGroup('nano_banana_apply_color_palette')).toBe('workspace');

            const registry = createDefaultToolRegistry();
            expect(registry.get('nano_banana_extract_color_palette')).toBeUndefined();
            expect(registry.get('nano_banana_transfer_color')).toBeUndefined();
        });

        it('recolors the target with the image model, sending the prompt built from exactly the palette given', async () => {
            const registry = createDefaultToolRegistry();
            const applyOutcome = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: targetPath,
                palette: completePalette,
                preserveSkinTones: true,
                contrastCurve: 'cinematic',
                aspectRatio: '16:9'
            }, {} as any);

            expect(applyOutcome.exec.status).toBe('completed');
            const prompt = (applyOutcome.resultPayload as any).applicationPrompt as string;
            expect(prompt).toContain('GLOBAL COLOR OVERRIDE');
            expect(prompt).toContain('Fjord Slate (#3A4A5C');
            expect(prompt).toContain('Lichen Ochre (#B8952E');
            // None of the builder's stock colors are filled in.
            expect(prompt).not.toContain('#0F172A');
            expect(prompt).not.toContain('#06B6D4');
            // The edit ran: the model got the prompt and the target's own pixels, and its image is on disk.
            expect(requests).toHaveLength(1);
            expect(requests[0].contents[0].text).toBe(prompt);
            expect(requests[0].contents[1].inlineData.data).toBe((await fs.readFile(targetPath)).toString('base64'));
            expect(requests[0].config.imageConfig).toEqual({ aspectRatio: '16:9' });
            const payload = applyOutcome.resultPayload as any;
            expect(payload.outputPath).toBe(path.join(tmpDir, 'target_palette.png'));
            expect((await fs.readFile(payload.outputPath)).equals(modelPng)).toBe(true);
            expect(payload.width).toBe(8);
            expect(payload.modelUsed).toBe('gemini-3.1-flash-image');
            expect(payload).not.toHaveProperty('geometryLocked');
            expect(payload).not.toHaveProperty('globalColorOverride');

            const fromJson = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: targetPath,
                outputPath: path.join(tmpDir, 'out', 'json.png'),
                palette: JSON.stringify(completePalette)
            }, {} as any);
            expect(fromJson.exec.status).toBe('completed');
            expect(await fs.pathExists(path.join(tmpDir, 'out', 'json.png'))).toBe(true);
        });

        it('fails with a typed error, writing nothing, when the target is missing or no model is available', async () => {
            const registry = createDefaultToolRegistry();
            const noFile = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: path.join(tmpDir, 'absent.png'),
                palette: completePalette
            }, {} as any);
            expect(noFile.exec.status).toBe('failed');
            expect(noFile.resultPayload.error).toContain('no file at');

            vi.mocked(GoogleMediaCredentialsService.prototype.createClient).mockRejectedValue(new Error('no credentials configured'));
            const noModel = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: targetPath,
                palette: completePalette
            }, {} as any);
            expect(noModel.exec.status).toBe('failed');
            expect(noModel.resultPayload.error).toContain('no credentials configured');
            expect(await fs.pathExists(path.join(tmpDir, 'target_palette.png'))).toBe(false);
        });

        it('fails with MissingInputError for a missing or incomplete palette instead of filling in stock colors', async () => {
            const registry = createDefaultToolRegistry();

            const missing = await registry.dispatch('nano_banana_apply_color_palette', { targetImageUrl: 'test.jpg' }, {} as any);
            expect(missing.exec.status).toBe('failed');
            expect(missing.resultPayload.error).toContain('palette');

            const freeText = await registry.dispatch('nano_banana_apply_color_palette', { targetImageUrl: 'test.jpg', palette: 'warm sunset tones' }, {} as any);
            expect(freeText.exec.status).toBe('failed');
            expect(freeText.resultPayload.error).toContain('JSON object');

            const noAccents = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: 'test.jpg',
                palette: { ...completePalette, accentTones: [] }
            }, {} as any);
            expect(noAccents.exec.status).toBe('failed');
            expect(noAccents.resultPayload.error).toContain('palette.accentTones');
        });

        it('accepts a temperature outside warm/cool/neutral, and adds no ratio or contrast the caller did not give', async () => {
            const registry = createDefaultToolRegistry();
            const outcome = await registry.dispatch('nano_banana_apply_color_palette', {
                targetImageUrl: targetPath,
                palette: { ...completePalette, shadowProfile: { tone: 'Blue-grey shadow', temperature: '5600K' } }
            }, {} as any);
            expect(outcome.exec.status).toBe('completed');
            const prompt = (outcome.resultPayload as any).applicationPrompt as string;
            expect(prompt).toContain('Blue-grey shadow (5600K temperature)');
            expect(prompt).toContain('Keep the target image\'s own aspect ratio.');
            expect(prompt).not.toContain('cinematic contrast');
        });

        it('buildToolDeclarations includes the palette application tool on color transfer prompts', () => {
            const registry = createDefaultToolRegistry();

            const configs = buildToolDeclarations({
                prompt: 'Please extract color palette from reference.jpg and transfer color to target.png using nano banana'
            }, registry);

            const funcDecls = configs?.flatMap(c => c.functionDeclarations || []) || [];
            expect(funcDecls.some(d => d.name === 'nano_banana_apply_color_palette')).toBe(true);
            expect(funcDecls.some(d => d.name === 'nano_banana_extract_color_palette')).toBe(false);
            expect(funcDecls.some(d => d.name === 'nano_banana_transfer_color')).toBe(false);
        });
    });

    describe('Task Capability Resolver Integration', () => {
        it('resolves Nano Banana color transfer requests natively to Tier 1 with the tool that exists', () => {
            const resolution = TaskCapabilityResolver.resolveTaskCapability(
                'Extract and apply color from reference image to target image using nano banana method 2'
            );

            expect(resolution.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
            expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('Nano Banana Color Transfer Pipeline'))).toBe(true);
            expect(resolution.tier1Assessment.suggestedNativeAction?.targetTool).toBe('nano_banana_apply_color_palette');
        });
    });
});
