/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { extractYamlFrontmatter } from '../common/markdown-ast-chunker';

export interface PromptTemplateParameter {
    name: string;
    description?: string;
    default?: string;
}

export interface MarkdownPromptTemplateMetadata {
    id: string;
    name: string;
    description?: string;
    model?: string;
    temperature?: number;
    system?: string;
    tags?: string[];
    parameters: PromptTemplateParameter[];
    filePath?: string;
}

export interface MarkdownPromptTemplate extends MarkdownPromptTemplateMetadata {
    templateContent: string;
}

export interface TemplateInterpolationContext {
    selection?: string;
    title?: string;
    file?: string;
    workspace?: string;
    date?: string;
    variables?: Record<string, string>;
    [key: string]: any;
}

/**
 * Parses a markdown prompt template file or raw string.
 */
export function parseMarkdownPromptTemplate(
    content: string,
    filePath?: string
): MarkdownPromptTemplate {
    const { frontmatter, body } = extractYamlFrontmatter(content);
    const id = filePath ? path.basename(filePath, path.extname(filePath)) : `template-${Date.now()}`;
    const name = String(frontmatter.name || frontmatter.title || id);

    const parameters: PromptTemplateParameter[] = [];
    if (Array.isArray(frontmatter.parameters)) {
        for (const p of frontmatter.parameters) {
            if (typeof p === 'object' && p !== null && p.name) {
                parameters.push({
                    name: String(p.name),
                    description: p.description ? String(p.description) : undefined,
                    default: p.default ? String(p.default) : undefined
                });
            } else if (typeof p === 'string') {
                parameters.push({ name: p });
            }
        }
    }

    return {
        id,
        name,
        description: frontmatter.description ? String(frontmatter.description) : undefined,
        model: frontmatter.model ? String(frontmatter.model) : undefined,
        temperature: typeof frontmatter.temperature === 'number' ? frontmatter.temperature : undefined,
        system: frontmatter.system ? String(frontmatter.system) : undefined,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : undefined,
        parameters,
        filePath,
        templateContent: body.trim()
    };
}

/**
 * Interpolates template variables into the prompt template body.
 */
export function interpolatePromptTemplate(
    template: MarkdownPromptTemplate,
    context: TemplateInterpolationContext
): { systemInstruction?: string; prompt: string; model?: string; temperature?: number } {
    let result = template.templateContent;

    const todayStr = context.date || new Date().toISOString().split('T')[0];
    const replacements: Record<string, string> = {
        selection: context.selection || '',
        title: context.title || '',
        file: context.file || '',
        workspace: context.workspace || '',
        date: todayStr,
        ...(context.variables || {})
    };

    for (const [key, val] of Object.entries(context)) {
        if (key !== 'variables' && (typeof val === 'string' || typeof val === 'number')) {
            replacements[key] = String(val);
        }
    }

    for (const [key, val] of Object.entries(replacements)) {
        const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
        result = result.replace(pattern, val);
        const varPattern = new RegExp(`\\{\\{\\s*var:${key}\\s*\\}\\}`, 'g');
        result = result.replace(varPattern, val);
    }

    // Clean any unresolved {{...}} tags gracefully
    result = result.replace(/\{\{\s*[^}]+\s*\}\}/g, '');

    return {
        systemInstruction: template.system,
        prompt: result.trim(),
        model: template.model,
        temperature: template.temperature
    };
}

/**
 * Scans a workspace directory for prompt templates in `.scratchbox/prompts/` (or specified dir).
 */
export async function loadWorkspacePromptTemplates(
    workspaceRoot: string,
    subDir: string = '.scratchbox/prompts'
): Promise<MarkdownPromptTemplate[]> {
    const targetDir = path.join(workspaceRoot, subDir);
    if (!fs.existsSync(targetDir)) {
        return [];
    }

    try {
        const files = await fs.promises.readdir(targetDir);
        const templates: MarkdownPromptTemplate[] = [];

        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            const fullPath = path.join(targetDir, file);
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            templates.push(parseMarkdownPromptTemplate(content, fullPath));
        }

        return templates;
    } catch {
        return [];
    }
}

/**
 * Service managing workspace prompt templates, seeding built-in PKB-inspired templates,
 * and interpolating contextual variables.
 */
export class MarkdownPromptTemplateService {
    private templatesDir: string;
    private workspaceRoot: string;
    private subDir: string;

    constructor(workspaceRoot: string, subDir: string = '.scratchbox/prompts') {
        this.workspaceRoot = workspaceRoot;
        this.subDir = subDir;
        this.templatesDir = path.join(workspaceRoot, subDir);
    }

    async initialize(): Promise<void> {
        if (!fs.existsSync(this.templatesDir)) {
            await fs.promises.mkdir(this.templatesDir, { recursive: true });
        }
        await this.seedBuiltInTemplates();
    }

    private async seedBuiltInTemplates(): Promise<void> {
        const builtins: Array<{ id: string; content: string }> = [
            {
                id: 'to-table',
                content: `---
name: "Transform to Comparison Table"
description: "Transforms unstructured text or lists into an organized Markdown comparison table"
parameters:
  - name: "selection"
    description: "The text to convert to a table"
tags: ["table", "formatting"]
---

Please convert the following text or list into a clean, well-formatted Markdown table with appropriate headers:

{{selection}}

File: {{file}}
`
            },
            {
                id: 'to-checklist',
                content: `---
name: "Convert to Actionable Checklist"
description: "Extracts action items and tasks into an interactive Markdown checklist"
parameters:
  - name: "selection"
    description: "The text containing requirements or tasks"
tags: ["tasks", "checklist"]
---

Extract and convert all actionable tasks from the following text into a Markdown task checklist (- [ ] Task):

{{selection}}
`
            },
            {
                id: 'ai-callout',
                content: `---
name: "Generate AI Provenance Callout"
description: "Synthesizes input into a collapsible AI callout block"
parameters:
  - name: "selection"
    description: "The text to analyze or synthesize"
tags: ["callout", "provenance"]
---

Synthesize the following text into a structured summary:

{{selection}}
`
            },
            {
                id: 'refine-selection',
                content: `---
name: "Refine and Clarify Excerpt"
description: "Polishes grammar, clarity, and conciseness while preserving technical terms"
parameters:
  - name: "selection"
    description: "The text to refine"
tags: ["writing", "clarity"]
---

Refine and clarify the following text for publication quality while preserving technical accuracy:

{{selection}}
`
            }
        ];

        for (const t of builtins) {
            const filePath = path.join(this.templatesDir, `${t.id}.md`);
            if (!fs.existsSync(filePath)) {
                await fs.promises.writeFile(filePath, t.content, 'utf-8');
            }
        }
    }

    async listTemplates(): Promise<MarkdownPromptTemplate[]> {
        return loadWorkspacePromptTemplates(this.workspaceRoot, this.subDir);
    }

    async getTemplate(id: string): Promise<MarkdownPromptTemplate | undefined> {
        const filePath = path.join(this.templatesDir, `${id}.md`);
        if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return parseMarkdownPromptTemplate(content, filePath);
        }
        const all = await this.listTemplates();
        return all.find(t => t.id === id);
    }

    async saveTemplate(id: string, content: string): Promise<void> {
        if (!fs.existsSync(this.templatesDir)) {
            await fs.promises.mkdir(this.templatesDir, { recursive: true });
        }
        const cleanId = id.replace(/\.md$/, '');
        const filePath = path.join(this.templatesDir, `${cleanId}.md`);
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }

    async renderTemplate(
        id: string,
        context: TemplateInterpolationContext | Record<string, string>
    ): Promise<string> {
        const template = await this.getTemplate(id);
        if (!template) {
            throw new Error(`Template not found: ${id}`);
        }
        const result = interpolatePromptTemplate(template, context as TemplateInterpolationContext);
        return result.prompt;
    }
}
