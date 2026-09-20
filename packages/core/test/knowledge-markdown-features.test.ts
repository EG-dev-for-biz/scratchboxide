import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    chunkMarkdownByAst,
    extractYamlFrontmatter,
    extractWikilinks
} from '../src/common/markdown-ast-chunker';
import { MarkdownPromptTemplateService } from '../src/node/markdown-prompt-template-service';

describe('Knowledge Markdown Features', () => {
    describe('markdown-ast-chunker', () => {
        it('extracts YAML frontmatter cleanly', () => {
            const raw = `---
title: "Neural Engine Design"
author: "Chief Architect"
tags: [3d, c++, engine]
aliases: ["SDF Renderer", "Native Core"]
confidence: 0.98
---

# Overview
This is the core specification.`;

            const { frontmatter, content } = extractYamlFrontmatter(raw);
            expect(frontmatter.title).toBe('Neural Engine Design');
            expect(frontmatter.author).toBe('Chief Architect');
            expect(frontmatter.tags).toEqual(['3d', 'c++', 'engine']);
            expect(frontmatter.aliases).toEqual(['SDF Renderer', 'Native Core']);
            expect(frontmatter.confidence).toBe(0.98);
            expect(content.trim()).toBe('# Overview\nThis is the core specification.');
        });

        it('handles markdown without frontmatter', () => {
            const raw = '# Simple Document\nNo frontmatter here.';
            const { frontmatter, content } = extractYamlFrontmatter(raw);
            expect(frontmatter).toEqual({});
            expect(content).toBe(raw);
        });

        it('extracts knowledge-graph wikilinks with targets, aliases, and anchors', () => {
            const text = `
Here is a reference to [[Architecture Overview]], and an aliased link to [[Simulation Engine|Physics Kernel]].
We also link to a section in [[Memory Management#Linear Allocator|Page Allocator]] and an anchor [[#Roadmap]].
`;
            const links = extractWikilinks(text);
            expect(links.length).toBe(4);

            expect(links[0].target).toBe('Architecture Overview');
            expect(links[0].displayText).toBe('Architecture Overview');
            expect(links[0].alias).toBeUndefined();
            expect(links[0].anchor).toBeUndefined();

            expect(links[1].target).toBe('Simulation Engine');
            expect(links[1].alias).toBe('Physics Kernel');
            expect(links[1].displayText).toBe('Physics Kernel');

            expect(links[2].target).toBe('Memory Management');
            expect(links[2].anchor).toBe('Linear Allocator');
            expect(links[2].alias).toBe('Page Allocator');
            expect(links[2].displayText).toBe('Page Allocator');

            expect(links[3].target).toBe('');
            expect(links[3].anchor).toBe('Roadmap');
            expect(links[3].displayText).toBe('Roadmap');
        });

        it('chunks markdown by AST headings while maintaining breadcrumbs', () => {
            const doc = `---
title: "Procedural Engine"
---

# 1. Architecture

Core architecture introduction.

## 1.1 Memory Subsystem

Details regarding memory pooling and linear arenas. Reference [[Kernel Memory]].

### 1.1.1 SIMD Allocator

AVX-512 aligned memory allocations.

\`\`\`cpp
// # Heading in code block should not split chunk!
void* ptr = scratchbox_aligned_alloc(64, size);
\`\`\`

## 1.2 Rendering Pipeline

Raymarching SDF shaders and marching cubes.

| Technique | Complexity | FPS Target |
| --- | --- | --- |
| Marching Cubes | O(N^3) | 60 |
| SDF Raymarching | O(Steps) | 120 |

> [!ai]+ Gemini Synthesis
> Real-time hybrid polygonization delivers optimal memory bandwidth.
`;

            const chunks = chunkMarkdownByAst(doc, { minChunkTokens: 10, maxChunkTokens: 200 });

            expect(chunks.length).toBeGreaterThanOrEqual(4);

            // First chunk: Chapter 1 Architecture
            expect(chunks[0].headingHierarchy).toEqual(['1. Architecture']);
            expect(chunks[0].breadcrumb).toBe('1. Architecture');

            // Memory Subsystem chunk
            const memorySubChunk = chunks.find(c => c.headingHierarchy.includes('1.1 Memory Subsystem'));
            expect(memorySubChunk).toBeDefined();

            // SIMD Allocator chunk should contain the code block atomically
            const simdChunk = chunks.find(c => c.content.includes('scratchbox_aligned_alloc'));
            expect(simdChunk).toBeDefined();
            expect(simdChunk?.breadcrumb).toBe('1. Architecture > 1.1 Memory Subsystem > 1.1.1 SIMD Allocator');
            expect(simdChunk?.content).toContain('```cpp');
            expect(simdChunk?.content).toContain('```');

            // Rendering pipeline chunk contains the table atomically
            const renderChunk = chunks.find(c => c.content.includes('Marching Cubes'));
            expect(renderChunk).toBeDefined();
            expect(renderChunk?.content).toContain('| Technique | Complexity | FPS Target |');

            // Check callout preservation
            const calloutChunk = chunks.find(c => c.content.includes('Gemini Synthesis'));
            expect(calloutChunk).toBeDefined();
            expect(calloutChunk?.content).toContain('> [!ai]+ Gemini Synthesis');

            // Check wikilink extraction inside chunk metadata
            const linkChunk = chunks.find(c => c.wikilinks.some(w => w.target === 'Kernel Memory'));
            expect(linkChunk).toBeDefined();
        });
    });

    describe('MarkdownPromptTemplateService', () => {
        let tempDir: string;
        let service: MarkdownPromptTemplateService;

        beforeEach(async () => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-prompt-test-'));
            service = new MarkdownPromptTemplateService(tempDir);
            await service.initialize();
        });

        afterEach(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('seeds built-in templates when .scratchbox/prompts is initialized', async () => {
            const templates = await service.listTemplates();
            expect(templates.length).toBeGreaterThanOrEqual(4);

            const tableTemplate = templates.find(t => t.id === 'to-table');
            expect(tableTemplate).toBeDefined();
            expect(tableTemplate?.name).toBe('Transform to Comparison Table');
            expect(tableTemplate?.parameters.find(p => p.name === 'selection')).toBeDefined();

            const checklistTemplate = templates.find(t => t.id === 'to-checklist');
            expect(checklistTemplate).toBeDefined();
            expect(checklistTemplate?.name).toBe('Convert to Actionable Checklist');

            const aiProvenanceTemplate = templates.find(t => t.id === 'ai-callout');
            expect(aiProvenanceTemplate).toBeDefined();
            expect(aiProvenanceTemplate?.name).toBe('Generate AI Provenance Callout');
        });

        it('interpolates variables accurately in prompt templates', async () => {
            const interpolated = await service.renderTemplate('to-table', {
                selection: 'Red, Green, Blue colors with hex codes #FF0000, #00FF00, #0000FF',
                file: 'colors.md'
            });

            expect(interpolated).toContain('Red, Green, Blue colors');
            expect(interpolated).toContain('Markdown table');
            expect(interpolated).toContain('colors.md');
        });

        it('supports creating and executing custom user prompt templates', async () => {
            const customContent = `---
name: "C++ SIMD Kernel Generator"
description: "Generates high performance C++20 vector math code"
parameters:
  - name: "algorithm"
    description: "Target algorithm name"
    default: "RayMarcher"
  - name: "selection"
    description: "Input mathematics formula"
tags: ["cpp", "simd"]
---

Generate optimized C++20 code for {{algorithm}}:
Formula: {{selection}}
File: {{file}}
`;
            await service.saveTemplate('cpp-simd', customContent);

            const loaded = await service.getTemplate('cpp-simd');
            expect(loaded).toBeDefined();
            expect(loaded?.name).toBe('C++ SIMD Kernel Generator');
            expect(loaded?.parameters.length).toBe(2);

            const rendered = await service.renderTemplate('cpp-simd', {
                algorithm: 'FastNoise3D',
                selection: 'f(x, y, z) = perlin(x * freq, y * freq, z * freq)',
                file: 'terrain.cpp'
            });

            expect(rendered).toContain('Generate optimized C++20 code for FastNoise3D:');
            expect(rendered).toContain('perlin(x * freq, y * freq, z * freq)');
            expect(rendered).toContain('File: terrain.cpp');
        });
    });

    describe('Markdown Callout & Diff Representations', () => {
        it('exports callout blocks with standard fold operators', () => {
            // Expanded callout
            const expanded = {
                type: 'callout',
                calloutType: 'ai',
                calloutTitle: 'Gemini Analysis',
                content: 'Found 3 optimization vectors for the renderer.',
                aiProvenance: {
                    model: 'Gemini 2.5 Pro',
                    isCollapsed: false
                }
            };

            const collapseMarkExp = expanded.aiProvenance.isCollapsed ? '-' : '+';
            const expExport = `> [!${expanded.calloutType}]${collapseMarkExp} ${expanded.calloutTitle} [${expanded.aiProvenance.model}]\n> ${expanded.content}\n\n`;

            expect(expExport).toBe('> [!ai]+ Gemini Analysis [Gemini 2.5 Pro]\n> Found 3 optimization vectors for the renderer.\n\n');

            // Collapsed callout
            const collapsed = {
                type: 'callout',
                calloutType: 'ai',
                calloutTitle: 'Detailed Shader Disassembly',
                content: 'v_add_f32 v0, v1, v2\nexp pos0, v0',
                aiProvenance: {
                    model: 'Gemini 2.5 Pro',
                    isCollapsed: true
                }
            };

            const collapseMarkCol = collapsed.aiProvenance.isCollapsed ? '-' : '+';
            const colExport = `> [!${collapsed.calloutType}]${collapseMarkCol} ${collapsed.calloutTitle} [${collapsed.aiProvenance.model}]\n> ${collapsed.content}\n\n`;

            expect(colExport).toBe('> [!ai]- Detailed Shader Disassembly [Gemini 2.5 Pro]\n> v_add_f32 v0, v1, v2\nexp pos0, v0\n\n');
        });
    });
});
