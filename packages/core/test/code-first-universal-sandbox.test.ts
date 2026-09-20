import { describe, it, expect } from 'vitest';
import { classifyFallbackPrompt, synthesizeSandboxFallback, generateAdaptiveSandboxCode } from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { buildSandboxSrcDoc } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import { buildSystemInstruction, CANVAS_PRIMITIVES_SPECIFICATION } from '../src/node/gemini/prompt-builder';

describe('Code-First Universal Application Creation & In-Situ Commenting', () => {
    describe('Phase 1: Code-First Intent Engine & Adaptive Routing', () => {
        it('identifies app creation queries as sandbox requests rather than static menus', () => {
            const prompt1 = 'create a small app that tracks historical events of 1776';
            const classification1 = classifyFallbackPrompt(prompt1);
            expect(classification1.isSandboxRequest).toBe(true);

            const prompt2 = 'build an interactive audio sequencer tool';
            const classification2 = classifyFallbackPrompt(prompt2);
            expect(classification2.isSandboxRequest).toBe(true);

            const prompt3 = 'make a financial portfolio dashboard and calculator';
            const classification3 = classifyFallbackPrompt(prompt3);
            expect(classification3.isSandboxRequest).toBe(true);

            const prompt4 = 'vibe-code a custom 3d camera blocking tool';
            const classification4 = classifyFallbackPrompt(prompt4);
            expect(classification4.isSandboxRequest).toBe(true);
        });

        it('synthesizes adaptive, interactive React code with real historical data for 1776 app', () => {
            const fallback = synthesizeSandboxFallback('create a small app that tracks historical events of 1776', undefined);
            expect(fallback.artifact).toBeDefined();
            expect(fallback.artifact.type).toBe('live-code-sandbox');
            const data = fallback.artifact.data as any;
            expect(data.template).toBe('react');

            const entryFile = data.files.find((f: any) => f.isEntry);
            expect(entryFile).toBeDefined();
            expect(entryFile.content).toContain('1776');
            expect(entryFile.content).toContain('historical');
            expect(entryFile.content).toContain('useState');
        });

        it('generates rich domain-adaptive React code for open-ended queries', () => {
            const code = generateAdaptiveSandboxCode('orbital satellite tracking utility', 'Aerospace Tracker');
            expect(code).toContain('Aerospace Tracker');
            expect(code).toContain('useState');
        });
    });

    describe('Phase 2 & 3: In-Situ Visual Preview Commenting & Virtual @scratchbox/core SDK', () => {
        const dummyFiles = [
            { id: 'f1', name: 'App.tsx', language: 'react', content: 'export default function App() { return <div>Hello Sandbox</div>; }', isEntry: true }
        ];

        it('injects in-situ DOM element inspector into sandboxed iframe srcdoc', () => {
            const srcDoc = buildSandboxSrcDoc({
                title: 'Test App',
                template: 'react',
                files: dummyFiles
            });
            expect(srcDoc).toContain('sb-set-inspector-mode');
            expect(srcDoc).toContain('sb-insitu-element-selected');
            expect(srcDoc).toContain('dashed #0284c7');
            expect(srcDoc).toContain('getSelector');
            expect(srcDoc).toContain('getBoundingClientRect');
        });

        it('injects virtual @scratchbox/core SDK into sandboxed iframe runtime', () => {
            const srcDoc = buildSandboxSrcDoc({
                title: 'Test App',
                template: 'react',
                files: dummyFiles
            });
            expect(srcDoc).toContain('window.__ScratchboxSdk');
            expect(srcDoc).toContain('Google3DViewport');
            expect(srcDoc).toContain('AudioVisualizer');
            expect(srcDoc).toContain('MetricCard');
            expect(srcDoc).toContain('Notification');
            expect(srcDoc).toContain('useAtmosphere');
            expect(srcDoc).toContain("window.require");
            expect(srcDoc).toContain("@scratchbox/core");
        });
    });

    describe('Phase 4: Agent System Instruction Alignment', () => {
        it('includes Code-First Universal App Creation in agent system instructions', async () => {
            const mockRequest: any = {
                prompt: 'create a small app that tracks historical events of 1776',
                workspacePath: '/mock/workspace'
            };
            const instruction = await buildSystemInstruction(mockRequest, {} as any);
            expect(instruction).toContain('CODE-FIRST UNIVERSAL APPLICATION CREATION');
            expect(instruction).toContain('NEVER respond with a static multiple-choice menu');
            expect(instruction).toContain('IN-SITU VISUAL PIN REFINEMENT');
            expect(instruction).toContain('@scratchbox/core');
            expect(instruction).toContain('Google3DViewport');
        });

        it('includes Live Code Sandbox specifications in canvas specification export', () => {
            expect(CANVAS_PRIMITIVES_SPECIFICATION).toContain('live-code-sandbox');
            expect(CANVAS_PRIMITIVES_SPECIFICATION).toContain('CODE-FIRST UNIVERSAL APPLICATION CREATION');
            expect(CANVAS_PRIMITIVES_SPECIFICATION).toContain('@scratchbox/core');
        });
    });
});

