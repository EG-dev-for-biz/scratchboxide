/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import type { GeminiGenerateRequest, GroundingMetadata } from '../../common/gemini-protocol';
import type {
    CanvasArtifact,
    CitationItem,
    CodeFileTab,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    PrimitiveType,
    SandboxTemplate,
    Scene3DData
} from '../../browser/generative-canvas/canvas-types';
import { normalizePrimitiveType } from '../../browser/generative-canvas/canvas-types';
import { synthesizeComprehensiveDocument as synthesizeDocumentFromEngine } from '../../browser/generative-canvas/document-synthesis-engine';
import type { VideoTimelineData } from '../../browser/generative-canvas/services/video/videoTypes';
import { NativePythonRunnerService } from '../3d-engine/native-python-runner-service';
import { applyClayFirstPassBaseline } from './scene3d-clay-baseline';

type CustomMesh = NonNullable<Scene3DData['customMeshes']>[number];

/** Neutral default attribution for synthesized documents. */
export const DEFAULT_DOCUMENT_AUTHOR = 'Scratchbox Studio';

export interface ExtractedScratchboxTag {
    matched: boolean;
    type?: string;
    title?: string;
    summary?: string;
    version?: number;
    rawPayload?: string;
    cleanText?: string;
}

/**
 * Parses canonical <scratchboxPrimitive type="..." title="..." summary="..." version="..."> tags
 * from model output, providing zero-overhead, deterministic artifact extraction without fragile regex heuristics.
 */
export function extractScratchboxPrimitiveTag(modelText: string): ExtractedScratchboxTag {
    if (!modelText || typeof modelText !== 'string') {
        return { matched: false };
    }
    const tagRegex = /<scratchboxPrimitive\s+([^>]*?)>([\s\S]*?)(?:<\/scratchboxPrimitive>|$)/i;
    const match = modelText.match(tagRegex);
    if (!match) {
        return { matched: false };
    }

    const attrStr = match[1];
    const rawPayload = match[2].trim();

    // Parse attributes
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        attrs[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    }

    const rawType = (attrs.type || '').trim().toLowerCase();
    let normalizedType = rawType;
    if (normalizedType === 'action-checklist') normalizedType = 'checklist';
    if (normalizedType === 'skills-manager') normalizedType = 'skills-hub';
    if (normalizedType === 'rendered-document' || normalizedType === 'document' || normalizedType === 'doc') normalizedType = 'markdown-document';
    if (normalizedType === 'flow-graph' || normalizedType === 'graph') normalizedType = 'node-graph';
    if (normalizedType === 'metrics' || normalizedType === 'dashboard') normalizedType = 'metric-dashboard';
    if (normalizedType === 'kanban') normalizedType = 'kanban-board';
    if (normalizedType === 'form') normalizedType = 'interactive-form';
    if (normalizedType === 'sandbox' || normalizedType === 'code-sandbox' || normalizedType === 'playground' || normalizedType === 'code-playground') normalizedType = 'live-code-sandbox';
    if (normalizedType === '3d' || normalizedType === 'scene-3d' || normalizedType === 'spatial-scene' || normalizedType === '3d_scene' || normalizedType === '3d-world' || normalizedType === 'r3f-scene') normalizedType = '3d-scene';
    if (normalizedType === 'video-timeline' || normalizedType === 'video' || normalizedType === 'timeline' || normalizedType === 'video-editor' || normalizedType === 'nle' || normalizedType === 'video_timeline') normalizedType = 'video-timeline';

    const cleanText = modelText.replace(/<scratchboxPrimitive[\s\S]*?(?:<\/scratchboxPrimitive>|$)/gi, '').trim();

    return {
        matched: true,
        type: normalizedType || undefined,
        title: attrs.title || undefined,
        summary: attrs.summary || undefined,
        version: attrs.version ? parseInt(attrs.version, 10) : 1,
        rawPayload,
        cleanText
    };
}

/**
 * Convert markdown string to structured MarkdownSection items.
 */
export function markdownStringToSections(md: string): MarkdownSection[] {
    const lines = md.split('\n');
    const sections: MarkdownSection[] = [];
    let currentParagraph: string[] = [];
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];
    let currentChecklist: Array<{ id: string; text: string; done: boolean }> = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines: string[] = [];

    const flushParagraph = () => {
        if (currentParagraph.length > 0) {
            const firstLine = currentParagraph[0].trim();
            // Check for explicit GitHub/Markdown style callout syntax on first line: > [!NOTE], > [!TIP], > [!INFO], > [!WARNING], > [!IMPORTANT]
            const calloutMatch = firstLine.match(/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\](?:\s+(.+))?$/i);

            if (calloutMatch) {
                const rawType = calloutMatch[1].toLowerCase();
                let calloutType: 'info' | 'tip' | 'warning' = 'info';
                if (rawType === 'tip') calloutType = 'tip';
                else if (rawType === 'warning' || rawType === 'caution' || rawType === 'important') calloutType = 'warning';

                const rawTitle = calloutMatch[2] ? calloutMatch[2].replace(/^[-:\s]+/, '').trim() : '';
                const defaultTitle = rawType.charAt(0).toUpperCase() + rawType.slice(1);
                const calloutTitle = rawTitle || defaultTitle;

                const bodyLines = currentParagraph.slice(1).map(l => l.replace(/^>\s*/, '').trim()).filter(Boolean);
                const calloutBody = bodyLines.join(' ').trim();

                sections.push({
                    id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'callout',
                    calloutType,
                    calloutTitle,
                    content: calloutBody || calloutTitle
                });
            } else if (firstLine.startsWith('>')) {
                // Check if blockquote has a bold title prefix like: > **Primary Source Callout:** ... or > **Key Insight**: ...
                const cleanQuote = currentParagraph.map(l => l.replace(/^>\s*/, '').trim()).join(' ').trim();
                const boldCalloutMatch = cleanQuote.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i);
                if (boldCalloutMatch) {
                    const calloutTitle = boldCalloutMatch[1].trim();
                    const calloutBody = boldCalloutMatch[2].trim() || cleanQuote;
                    sections.push({
                        id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'callout',
                        calloutType: 'info',
                        calloutTitle,
                        content: calloutBody
                    });
                } else if (cleanQuote) {
                    sections.push({
                        id: `sec-quote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'quote',
                        content: cleanQuote
                    });
                }
            } else {
                // Standard rich paragraph (NOT converted to callouts)
                const text = currentParagraph.join(' ').trim();
                if (text) {
                    sections.push({
                        id: `sec-p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'paragraph',
                        content: text
                    });
                }
            }
            currentParagraph = [];
        }
    };

    const flushTable = () => {
        if (inTable && tableHeaders.length > 0) {
            sections.push({
                id: `sec-tbl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'table',
                tableHeaders,
                tableRows
            });
            tableHeaders = [];
            tableRows = [];
            inTable = false;
        }
    };

    const flushChecklist = () => {
        if (currentChecklist.length > 0) {
            sections.push({
                id: `sec-chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'checklist',
                checklistItems: currentChecklist
            });
            currentChecklist = [];
        }
    };

    const flushCodeBlock = () => {
        if (inCodeBlock) {
            sections.push({
                id: `sec-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'code',
                codeLanguage: codeLanguage || 'typescript',
                content: codeLines.join('\n')
            });
            codeLines = [];
            codeLanguage = '';
            inCodeBlock = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Handle fenced code blocks
        if (trimmed.startsWith('```')) {
            if (inCodeBlock) {
                flushCodeBlock();
            } else {
                flushParagraph();
                flushTable();
                flushChecklist();
                inCodeBlock = true;
                codeLanguage = trimmed.slice(3).trim();
                codeLines = [];
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        // Headings (#, ##, ###, ####, etc.)
        if (trimmed.startsWith('#')) {
            flushParagraph();
            flushTable();
            flushChecklist();
            const levelMatch = trimmed.match(/^(#{1,6})\s*(.*)$/);
            if (levelMatch) {
                const level = Math.min(3, Math.max(1, levelMatch[1].length)) as (1 | 2 | 3);
                const headingContent = levelMatch[2].trim();
                if (headingContent) {
                    sections.push({
                        id: `sec-h${level}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'heading',
                        level,
                        content: headingContent
                    });
                }
            }
        }
        // Checklist items (- [ ] or - [x] or * [ ] or * [x])
        else if (/^[-*]\s+\[([ xX])\]\s+(.+)$/.test(trimmed)) {
            flushParagraph();
            flushTable();
            const checkMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
            if (checkMatch) {
                const done = checkMatch[1].toLowerCase() === 'x';
                const text = checkMatch[2].trim();
                currentChecklist.push({
                    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    text,
                    done
                });
            }
        }
        // Tables (| col 1 | col 2 |)
        else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushParagraph();
            flushChecklist();
            const cells = trimmed
                .split('|')
                .map(c => c.trim())
                .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);

            if (cells.every(c => /^:?-+:?$/.test(c))) {
                // separator line
                inTable = true;
            } else if (!inTable && tableHeaders.length === 0) {
                tableHeaders = cells;
            } else {
                inTable = true;
                tableRows.push(cells);
            }
        }
        // Explicit callout header line (e.g. > [!NOTE] or > [!TIP])
        else if (/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\]/i.test(trimmed)) {
            flushParagraph();
            flushTable();
            flushChecklist();
            currentParagraph.push(trimmed);
        }
        // Blank lines flush active paragraph/table/checklist
        else if (trimmed === '') {
            flushParagraph();
            flushTable();
            flushChecklist();
        } else {
            if (inTable) {
                flushTable();
            }
            if (currentChecklist.length > 0) {
                flushChecklist();
            }
            currentParagraph.push(trimmed);
        }
    }

    flushParagraph();
    flushTable();
    flushChecklist();
    flushCodeBlock();

    return sections.length > 0
        ? sections
        : [
              {
                  id: `sec-default`,
                  type: 'paragraph',
                  content: md.slice(0, 2000)
              }
          ];
}

/**
 * Models sometimes return a `import scratchbox as sb` Python script inside `cppGenerator.sourceCode`;
 * the C++ compile path cannot run it, so it is moved to `pythonGenerator` where it is executed.
 */
export function reclassifyMisfiledPythonGenerator<T extends Pick<Scene3DData, 'cppGenerator' | 'pythonGenerator'>>(data: T | undefined): T | undefined {
    const src = data?.cppGenerator?.sourceCode;
    if (!data || !src || data.pythonGenerator?.sourceCode) return data;
    const isPython = /^\s*(?:import\s+scratchbox|from\s+scratchbox\s+import)\b/m.test(src) && !/^\s*#\s*include\b/m.test(src);
    if (!isPython) return data;
    const { cppGenerator: _misfiled, ...rest } = data;
    return {
        ...rest,
        pythonGenerator: { enabled: true, filename: 'procedural_scene.py', sourceCode: src }
    } as T;
}

/**
 * Turns the runnable code blocks in the model's reply into a live sandbox (viewMode 'preview').
 * Returns null when the reply has no runnable code: no app is written from the prompt's words.
 */
export function extractCodeSandboxArtifact(
    prompt: string,
    cleanContent: string,
    activeArtifact?: CanvasArtifact
): { artifact: CanvasArtifact; hasRunnableCode: boolean } | null {
    // Match all fenced code blocks in cleanContent
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
    const matches: Array<{ language: string; content: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(cleanContent)) !== null) {
        const rawLang = (match[1] || '').trim().toLowerCase();
        const code = match[2];
        if (code && code.trim().length > 0) {
            matches.push({ language: rawLang, content: code.trim() });
        }
    }

    const runnableMatches = matches.filter(m => {
        // Exclude Python 3D scripts intended for the native Scratchbox 3D engine (e.g., import scratchbox as sb)
        const isScratchboxPython = ['python', 'py'].includes(m.language) && (m.content.includes('scratchbox') || m.content.includes('import scratchbox') || m.content.includes('from scratchbox'));
        if (isScratchboxPython) return false;

        return ['tsx', 'jsx', 'react', 'html', 'htm', 'svg', 'javascript', 'js', 'typescript', 'ts', 'css', 'python', 'py'].includes(m.language) ||
            /import\s+React|export\s+default\s+function|<\w+[\s>]|<!DOCTYPE\s+html|<svg/i.test(m.content);
    });

    if (runnableMatches.length === 0) {
        return null;
    }

    const timestamp = new Date().toISOString();
    let title = extractDocumentTitle(prompt, 'Interactive Live Preview');
    if (title.toLowerCase().startsWith('strategic') || title.toLowerCase().startsWith('project specification')) {
        title = 'Interactive Live Preview';
    }

    let template: SandboxTemplate = 'react';
    const files: CodeFileTab[] = [];
    const dependencies: Record<string, string> = {
        'lucide-react': '^0.468.0',
        'canvas-confetti': '^1.9.3',
        'three': '^0.160.0',
        'framer-motion': '^11.0.0'
    };

    if (runnableMatches.length > 0) {
        const hasReact = runnableMatches.some(m => ['tsx', 'jsx', 'react'].includes(m.language) || (['typescript', 'ts', 'javascript', 'js'].includes(m.language) && /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content)));
        const hasHtml = runnableMatches.some(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
        const hasPython = runnableMatches.some(m => ['python', 'py'].includes(m.language));

        if (hasReact || (!hasHtml && !hasPython)) {
            template = 'react';
            let appFound = false;
            runnableMatches.forEach((m, idx) => {
                const isCodeReact = ['tsx', 'jsx', 'react', 'typescript', 'ts', 'javascript', 'js'].includes(m.language) || /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content);
                if (isCodeReact && !appFound) {
                    files.push({
                        id: 'file-app',
                        name: 'App.tsx',
                        language: 'react',
                        content: m.content,
                        isEntry: true
                    });
                    appFound = true;
                } else if (m.language === 'css') {
                    files.push({
                        id: `file-css-${idx}`,
                        name: 'styles.css',
                        language: 'css',
                        content: m.content
                    });
                } else {
                    files.push({
                        id: `file-${idx}`,
                        name: `Component_${idx}.tsx`,
                        language: 'react',
                        content: m.content
                    });
                }
            });
            if (!files.some(f => f.name === 'styles.css')) {
                files.push({
                    id: 'file-css-default',
                    name: 'styles.css',
                    language: 'css',
                    content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; }`
                });
            }
        } else if (hasHtml) {
            template = 'vanilla-html';
            const htmlMatch = runnableMatches.find(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
            let htmlContent = htmlMatch!.content;
            if (htmlMatch?.language === 'svg' || htmlContent.trim().startsWith('<svg')) {
                htmlContent = `<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #09090b; color: #fff; }\n    svg { max-width: 90vw; max-height: 85vh; filter: drop-shadow(0 20px 30px rgba(0,0,0,0.5)); }\n  </style>\n</head>\n<body>\n  ${htmlContent}\n</body>\n</html>`;
            }
            files.push({
                id: 'file-index',
                name: 'index.html',
                language: 'html',
                content: htmlContent,
                isEntry: true
            });
            const cssMatch = runnableMatches.find(m => m.language === 'css');
            if (cssMatch) {
                files.push({
                    id: 'file-styles',
                    name: 'styles.css',
                    language: 'css',
                    content: cssMatch.content
                });
            }
        } else if (hasPython) {
            template = 'python';
            const pyMatch = runnableMatches.find(m => ['python', 'py'].includes(m.language));
            files.push({
                id: 'file-main-py',
                name: 'main.py',
                language: 'python',
                content: pyMatch!.content,
                isEntry: true
            });
        }
    }
    if (files.length === 0) {
        return null;
    }

    const sandboxData: LiveCodeSandboxData = {
        title,
        subtitle: `Live interactive preview generated for ${title}`,
        template,
        files,
        activeFileId: files.find(f => f.isEntry)?.id || files[0]?.id,
        viewMode: 'preview',
        viewportMode: 'desktop',
        autoRun: true,
        dependencies
    };

    const artifact: CanvasArtifact = {
        id: (activeArtifact?.type === 'live-code-sandbox' ? activeArtifact.id : undefined) || `art-sandbox-${Date.now()}`,
        type: 'live-code-sandbox',
        title,
        summary: sandboxData.subtitle || `Interactive live preview for ${title}`,
        version: (activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.version || 1) + 1 : 1),
        createdAt: timestamp,
        data: sandboxData
    };

    return {
        artifact,
        hasRunnableCode: runnableMatches.length > 0
    };
}

/** The title of a document nobody named: a neutral label, never a made-up subject. */
export const UNTITLED_DOCUMENT_TITLE = 'Untitled document';

/**
 * A document title taken from the request's own words (the subject after "write a document about ..."), for a
 * document the model sent without one. When no subject is left, the fallback (by default "Untitled document");
 * no canned title is picked by keyword.
 */
export function extractDocumentTitle(prompt: string, fallback: string = UNTITLED_DOCUMENT_TITLE): string {
    const cleanPrompt = prompt
        .replace(/^[\s\W]*(write|create|generate|draft|build|make)?\s*(a|an|the)?\s*(document|spec|specification|overview|notes|guide|report|proposal)?\s*(about|for|on|of)?\s*/i, '')
        .replace(/for section ["'].*?["']/i, '')
        .replace(/in document ["'](.*?)["']/i, '$1')
        .replace(/[?.!]+$/, '')
        .trim();

    if (cleanPrompt.length > 2 && cleanPrompt !== 'selected content') {
        return cleanPrompt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 75);
    }
    return fallback && fallback !== 'Markdown Document' ? fallback : UNTITLED_DOCUMENT_TITLE;
}

/**
 * Synthesize a comprehensive, executive document hierarchy for any topic with rich 4D capabilities.
 */
export function synthesizeComprehensiveDocument(prompt: string, customTitle?: string): MarkdownDocumentData {
    return synthesizeDocumentFromEngine(prompt, customTitle || extractDocumentTitle(prompt));
}

/**
 * Editor state a video timeline needs to open (frame rate, playhead, zoom, frame shape). Only the model's own tracks,
 * clips and media are kept; nothing is added to them. Duration is the end of the last clip when the model gave none.
 */
export function normalizeModelVideoTimeline(raw: Record<string, any> | undefined, title: string | undefined): VideoTimelineData {
    const data = raw && typeof raw === 'object' ? raw : {};
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    const clipEnd = tracks.reduce((end: number, track: any) => {
        const clips = Array.isArray(track?.clips) ? track.clips : [];
        return clips.reduce((e: number, c: any) => Math.max(e, (Number(c?.startTime) || 0) + (Number(c?.duration) || 0)), end);
    }, 0);
    return {
        ...data,
        title: data.title || title || 'Video Timeline',
        fps: typeof data.fps === 'number' ? data.fps : 30,
        duration: typeof data.duration === 'number' ? data.duration : clipEnd,
        currentTime: typeof data.currentTime === 'number' ? data.currentTime : 0,
        tracks,
        mediaAssets: Array.isArray(data.mediaAssets) ? data.mediaAssets : [],
        zoom: typeof data.zoom === 'number' ? data.zoom : 40,
        aspectRatio: data.aspectRatio || '16:9'
    } as VideoTimelineData;
}

/** A scene log continued by the model's entries; an empty list from the model is its explicit reset. */
function appendLog<T>(open: T[] | undefined, sent: T[] | undefined | null): T[] {
    if (Array.isArray(sent) && sent.length === 0) return [];
    return [...(open || []), ...(Array.isArray(sent) ? sent : [])];
}

/**
 * The 3D scene the model sent. A 3d-scene envelope sent while a 3d-scene is open is the next version of that scene
 * (same artifact id), so it is read as an update: every field the model's data contains is taken as sent (an
 * explicit `null` or `[]` clears it) and every field it leaves out keeps the open scene's value. Whether the prompt
 * starts something new is the model's call, expressed by what it sends (a new generator, `objects: []`); no prompt
 * wording is read. No template supplies geometry, scripts, generators, a title, a camera or lighting.
 */
function modelAuthoredScene(prompt: string, request: GeminiGenerateRequest, title: string, summary: string | undefined, raw: unknown): Scene3DData {
    const data = reclassifyMisfiledPythonGenerator((raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Scene3DData)!;
    const open = request.activeArtifact?.type === '3d-scene' ? (request.activeArtifact.data as Scene3DData | undefined) : undefined;
    const sent = (key: keyof Scene3DData) => Object.prototype.hasOwnProperty.call(data, key);
    const pick = <K extends keyof Scene3DData>(key: K): Scene3DData[K] | undefined => (sent(key) ? data[key] : open?.[key]) ?? undefined;

    // Features merge key by key: the model's keys over the open scene's. Sky and atmosphere come only from these
    // (and, on a first pass, the AGENTS.md opt-in gate in applyClayFirstPassBaseline strips any the prompt did not ask for).
    const features: NonNullable<Scene3DData['features']> = { ...(open?.features || {}), ...(data.features || {}) };

    // A generator the model sends replaces the open scene's generators, of either engine.
    const sentGenerator = sent('pythonGenerator') || sent('cppGenerator');
    let pythonGenerator = sentGenerator ? data.pythonGenerator ?? undefined : open?.pythonGenerator;
    const cppGenerator = sentGenerator ? data.cppGenerator ?? undefined : open?.cppGenerator;
    if (pythonGenerator?.sourceCode && !pythonGenerator.glbBase64) {
        // Built now when the engine can; otherwise the viewport builds it and shows any error.
        try {
            const res = NativePythonRunnerService.getInstance().runScriptSync(pythonGenerator.sourceCode);
            if (res.success && res.glbBase64) {
                pythonGenerator = { ...pythonGenerator, enabled: true, glbBase64: res.glbBase64, glbPath: res.glbPath, lastCompiledTimeMs: Date.now() };
            }
        } catch (e) {
            console.warn('[ArtifactSynthesis] Error running pythonGenerator synchronously:', e);
        }
    }

    // Custom meshes the model sends are merged by id over the open scene's (keeping the user's gizmo transforms).
    const customMeshes = (() => {
        if (!Array.isArray(data.customMeshes)) return sent('customMeshes') ? undefined : open?.customMeshes;
        if (data.customMeshes.length === 0 || !open?.customMeshes?.length) return data.customMeshes;
        const map = new Map<string, CustomMesh>();
        open.customMeshes.forEach(m => map.set(m.id, { ...m }));
        (data.customMeshes as CustomMesh[]).forEach(m => {
            const existing = map.get(m.id);
            map.set(m.id, existing ? {
                ...existing,
                ...m,
                position: m.position || existing.position,
                rotation: m.rotation || existing.rotation,
                scale: m.scale || existing.scale,
                parentId: m.parentId ?? existing.parentId,
                material: { ...(existing.material || {}), ...(m.material || {}) }
            } : m);
        });
        return Array.from(map.values());
    })();

    const environment = {
        // AGENTS.md neutral baseline: an unconfigured scene is a studio.
        lighting: 'studio',
        ...(open?.environment || {}),
        ...(data.environment || {})
    };
    if (!environment.skybox) environment.skybox = features.atmosphericScattering ? 'realistic-sky' : 'studio';

    const scene: Scene3DData = {
        ...data,
        title,
        subtitle: summary || data.subtitle || open?.subtitle,
        worldBranch: pick('worldBranch'),
        sceneType: pick('sceneType'),
        renderMode: pick('renderMode'),
        cameraMode: pick('cameraMode'),
        animation: pick('animation'),
        camera: pick('camera'),
        environment,
        // Playback too: without a timeline from the model or the open scene, nothing starts playing.
        timeline: pick('timeline'),
        customScript: sent('customScript') || sent('code') ? (data.customScript ?? data.code) : open?.customScript,
        code: sent('code') || sent('customScript') ? (data.code ?? data.customScript) : open?.code,
        shaders: pick('shaders'),
        features,
        customMeshes,
        objects: Array.isArray(data.objects) ? data.objects : (sent('objects') ? [] : open?.objects ?? []),
        // Logs of what was done to the scene: the model's entries are appended; an empty list it sends resets the log.
        operatorStack: appendLog(open?.operatorStack, data.operatorStack),
        actionLog: appendLog(open?.actionLog, data.actionLog),
        sculptSettings: pick('sculptSettings'),
        selectedMeshId: pick('selectedMeshId'),
        wasmPhysics: pick('wasmPhysics'),
        geoAnchor: pick('geoAnchor'),
        droneRoute: pick('droneRoute'),
        cppGenerator,
        pythonGenerator
    };
    // A first pass is grey clay in a studio (user decision; AGENTS.md). A follow-up keeps the open scene's render
    // mode unless the model's data sets one: leaving clay is the model's call, not a colour word in the prompt.
    return open ? scene : applyClayFirstPassBaseline(scene, prompt);
}

/**
 * The sections of a document the model sent: its `sections` array, or its markdown when it sent the document as a
 * markdown string (the whole payload, or a `markdown` / `content` / `body` field). Empty when it sent neither; no
 * section is written for it.
 */
export function modelDocumentSections(raw: unknown): MarkdownSection[] {
    if (typeof raw === 'string') return raw.trim() ? markdownStringToSections(raw) : [];
    if (!raw || typeof raw !== 'object') return [];
    const doc = raw as Record<string, any>;
    if (Array.isArray(doc.sections) && doc.sections.length > 0) return doc.sections;
    const markdown = [doc.markdown, doc.content, doc.body].find(v => typeof v === 'string' && v.trim().length > 0);
    return markdown ? markdownStringToSections(markdown) : [];
}

/**
 * The model's document, with its sections' field aliases normalised (heading `title` -> `content`, ...) and Google
 * Search grounding citations appended. No heading, callout title, subtitle or section is written for it.
 */
function modelAuthoredDocument(
    prompt: string,
    request: GeminiGenerateRequest,
    parsedTitle: string | undefined,
    summary: string | undefined,
    raw: unknown,
    replyMarkdown: string,
    enrichGroundedCitations: (sections: MarkdownSection[]) => MarkdownSection[]
): MarkdownDocumentData {
    const named = (t: unknown) => (typeof t === 'string' && t.trim() && t !== 'Markdown Document' ? t : undefined);
    const rawObject = raw && typeof raw === 'object' ? raw as Record<string, any> : undefined;

    let sections: any[] = modelDocumentSections(raw);
    if (sections.length === 0 && typeof raw !== 'string' && replyMarkdown) {
        sections = markdownStringToSections(replyMarkdown);
    }
    const firstHeading = sections.find((s: any) => s?.type === 'heading' && typeof s.content === 'string' && s.content.trim())?.content;
    let docTitle = named(parsedTitle) || named(rawObject?.title) || named(request.activeArtifact?.title) || named(firstHeading) || extractDocumentTitle(prompt);

    // A follow-up that names a section of the open document replaces just that section with the model's sections.
    if (request.activeArtifact?.type === 'markdown-document' && request.activeArtifact.data) {
        const activeDoc = request.activeArtifact.data as MarkdownDocumentData;
        const sectionMatch = prompt.match(/for section ["'](.*?)["']/i) || prompt.match(/selected excerpt: ["'](.*?)["']/i);
        if (sectionMatch && activeDoc.sections && activeDoc.sections.length > 0) {
            const targetQuery = sectionMatch[1].toLowerCase().trim();
            const targetIdx = activeDoc.sections.findIndex(s => (s.content || s.calloutTitle || '').toLowerCase().includes(targetQuery));
            if (targetIdx !== -1 && sections.length > 0) {
                const merged = [...activeDoc.sections];
                merged.splice(targetIdx, 1, ...sections);
                sections = merged;
                docTitle = activeDoc.title || docTitle;
            }
        }
    }

    let headingCount = 0;
    sections = sections.map((sec: any, idx: number) => {
        if (!sec || typeof sec !== 'object') return sec;
        const secType = sec.type || 'paragraph';
        const id = sec.id || `sec-${secType}-${idx + 1}`;
        if (secType === 'heading') {
            const rawContent = sec.content ?? sec.heading ?? sec.title ?? sec.text ?? sec.name ?? sec.headingText ?? sec.value ?? '';
            const level = sec.level === 1 || sec.level === 2 || sec.level === 3 ? sec.level : (headingCount === 0 ? 1 : 2);
            headingCount++;
            return { ...sec, id, type: 'heading', level, content: typeof rawContent === 'string' ? rawContent.trim() : '' };
        }
        if (secType === 'callout') {
            let calloutTitle = sec.calloutTitle ?? sec.title ?? sec.heading ?? sec.name ?? '';
            let content = sec.content ?? sec.text ?? sec.body ?? '';
            if (!calloutTitle && typeof content === 'string') {
                // "**Title:** body" or "[!NOTE] body" written by the model carries its own title.
                const prefix = content.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i) || content.match(/^\[!([A-Z]+)\]\s*(.*)$/i);
                if (prefix) {
                    calloutTitle = prefix[1].trim();
                    content = prefix[2].trim() || content;
                }
            }
            return { ...sec, id, type: 'callout', calloutType: sec.calloutType || 'info', calloutTitle, content };
        }
        return { ...sec, id };
    });

    return {
        ...(rawObject || {}),
        title: docTitle,
        subtitle: rawObject?.subtitle || rawObject?.docSubtitle || rawObject?.description || summary,
        sections: enrichGroundedCitations(sections)
    } as MarkdownDocumentData;
}

/**
 * Builds the canvas artifact the model wrote in its reply: a <scratchboxPrimitive> tag or a JSON {type, data}
 * envelope that names a canvas primitive. Nothing is built from the prompt's words, in any mode: a reply in prose,
 * an empty tag or JSON that is not an envelope yields undefined (the canvas stays as it is).
 */
export function parseOrSynthesizeArtifact(
    prompt: string,
    modelText: string,
    request: GeminiGenerateRequest,
    _mcpExecutions: McpExecutionState[],
    groundingMetadata?: GroundingMetadata
): CanvasArtifact | undefined {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const enrichGroundedCitations = (targetSections: MarkdownSection[]): MarkdownSection[] => {
        if (!groundingMetadata?.groundingChunks || groundingMetadata.groundingChunks.length === 0) {
            return targetSections;
        }
        const groundedCitations: CitationItem[] = groundingMetadata.groundingChunks
            .filter(c => c.web && (c.web.uri || c.web.title))
            .map((c, idx) => ({
                id: `cite-google-${idx + 1}-${Date.now()}`,
                sourceTitle: c.web?.title || c.web?.uri || `Google Search Grounded Reference ${idx + 1}`,
                url: c.web?.uri,
                verified: true,
                badgeText: 'Google Search Verified',
                archiveName: 'Google Search Grounding'
            }));

        if (groundedCitations.length === 0) return targetSections;

        const citeIdx = targetSections.findIndex(s => s.type === 'citation');
        if (citeIdx !== -1) {
            const existingSec = targetSections[citeIdx];
            const existingUrls = new Set((existingSec.citationItems || []).map(ci => ci.url).filter(Boolean));
            const merged = [
                ...groundedCitations,
                ...(existingSec.citationItems || []).filter(ci => !ci.url || !existingUrls.has(ci.url))
            ];
            const newSections = [...targetSections];
            newSections[citeIdx] = { ...existingSec, citationItems: merged };
            return newSections;
        }
        return [
            ...targetSections,
            { id: `sec-citations-grounded-${Date.now()}`, type: 'citation' as const, citationItems: groundedCitations }
        ];
    };

    const versionFor = (type: PrimitiveType, ownVersion?: number, ownId?: string) => {
        const isSameType = request.activeArtifact?.type === type;
        return {
            id: (isSameType && request.activeArtifact) ? request.activeArtifact.id : (ownId || `art-${type}-${Date.now()}`),
            version: (isSameType && request.activeArtifact) ? (request.activeArtifact.version || 1) + 1 : (ownVersion || 1)
        };
    };

    // 1. Unified artifact tag: <scratchboxPrimitive type="..." title="..." summary="..." version="...">
    const primitiveTag = extractScratchboxPrimitiveTag(modelText);
    if (primitiveTag.matched && primitiveTag.type) {
        let tagType = normalizePrimitiveType(primitiveTag.type);
        const tagPayload = primitiveTag.rawPayload || '';

        // The body is a JSON block or object ...
        const jsonInTag = tagPayload.match(/```json\s*([\s\S]*?)\s*```/) || (tagPayload.startsWith('{') && tagPayload.endsWith('}') ? [null, tagPayload] : null);
        let parsedTagData: any = null;
        if (jsonInTag) {
            try {
                const parsed = JSON.parse(jsonInTag[1]!);
                if (parsed) {
                    parsedTagData = parsed.data !== undefined ? parsed.data : parsed;
                    // An inner `type` re-types the tag only when it names a primitive; otherwise it is a field of the data.
                    const innerType = normalizePrimitiveType(parsed.type);
                    if (innerType) tagType = innerType;
                }
            } catch {
                // Not JSON: read the body as code or markdown below.
            }
        }

        // ... or the model's code for a sandbox ...
        if (tagType === 'live-code-sandbox' && tagPayload.trim() && (!parsedTagData || !parsedTagData.files)) {
            const codeMatch = tagPayload.match(/```(?:tsx|jsx|react|typescript|ts|javascript|js|html)?\s*\n([\s\S]*?)```/) || [null, tagPayload];
            const rawCode = (codeMatch[1] || tagPayload).trim();
            const template: SandboxTemplate = rawCode.includes('def ') || rawCode.includes('import numpy') ? 'python' : 'react';
            parsedTagData = {
                title: primitiveTag.title || 'Interactive Micro-App',
                subtitle: primitiveTag.summary,
                template,
                viewMode: 'preview',
                viewportMode: 'desktop',
                dependencies: {
                    'lucide-react': '^0.468.0',
                    'canvas-confetti': '^1.9.3',
                    'three': '^0.160.0',
                    'framer-motion': '^11.0.0'
                },
                files: [
                    {
                        id: 'file-entry',
                        name: template === 'python' ? 'main.py' : 'App.tsx',
                        language: template === 'python' ? 'python' : 'react',
                        content: rawCode,
                        isEntry: true
                    },
                    {
                        id: 'file-css',
                        name: 'styles.css',
                        language: 'css',
                        content: '/* Scratchbox Sandbox Styles */\nbody { margin: 0; padding: 0; }'
                    }
                ],
                activeFileId: 'file-entry'
            };
        }

        // ... or the model's markdown for a document.
        if (tagType === 'markdown-document' && (!parsedTagData || !parsedTagData.sections)) {
            const rawSections = markdownStringToSections(tagPayload);
            if (rawSections.length > 0) {
                const firstHeading = rawSections.find(s => s.type === 'heading' && s.content)?.content;
                parsedTagData = {
                    title: primitiveTag.title || firstHeading || extractDocumentTitle(prompt, 'Document'),
                    subtitle: primitiveTag.summary,
                    author: DEFAULT_DOCUMENT_AUTHOR,
                    lastUpdated: 'Just now',
                    sections: enrichGroundedCitations(rawSections)
                };
            }
        }

        // The tag must name a canvas primitive and carry content; an unknown type or an empty body is not mounted.
        if (parsedTagData && tagType) {
            const { id, version } = versionFor(tagType, primitiveTag.version);
            return {
                id,
                type: tagType,
                title: primitiveTag.title || parsedTagData.title || tagType,
                summary: primitiveTag.summary || parsedTagData.subtitle || '',
                version,
                createdAt: timestamp,
                data: parsedTagData
            };
        }
    }

    // 2. A JSON {type, data} envelope naming a canvas primitive. Any other JSON block, such as an API payload or a
    // webhook event ({"type": "invoice.paid", "data": ...}), is just part of the reply.
    const replyMarkdown = modelText
        .replace(/<scratchboxPrimitive[\s\S]*?(?:<\/scratchboxPrimitive>|$)/gi, '')
        .replace(/```json[\s\S]*?```/g, '')
        .trim();
    const jsonMatch = modelText.match(/```json\s*([\s\S]*?)\s*```/) || modelText.match(/(\{[\s\S]*"type"[\s\S]*"data"[\s\S]*\})/);
    if (!jsonMatch) return undefined;
    let parsed: any;
    try {
        parsed = JSON.parse(jsonMatch[1]);
    } catch {
        return undefined;
    }
    const type = normalizePrimitiveType(parsed?.type);
    if (!parsed || typeof parsed !== 'object' || !type || parsed.data === undefined || parsed.data === null) return undefined;

    let data: any = parsed.data;
    let title: string | undefined = parsed.title;
    if (type === '3d-scene') {
        title = parsed.title || data?.title || (request.activeArtifact?.type === '3d-scene' ? request.activeArtifact.title : undefined) || '3D Scene';
        data = modelAuthoredScene(prompt, request, title!, parsed.summary, data);
    } else if (type === 'video-timeline') {
        data = normalizeModelVideoTimeline(data, parsed.title);
        title = parsed.title || data.title;
    } else if (type === 'markdown-document') {
        data = modelAuthoredDocument(prompt, request, parsed.title, parsed.summary, data, replyMarkdown, enrichGroundedCitations);
        title = data.title;
    }

    const { id, version } = versionFor(type, parsed.version, parsed.id);
    return {
        id,
        type,
        title: title || data?.title || type,
        summary: parsed.summary || data?.subtitle || '',
        version,
        createdAt: timestamp,
        data
    };
}
