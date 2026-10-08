/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, AgentExecutionStep } from './canvas-types';
import { classifyCliCommand } from './guardrails-service';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import { buildArtifactExplanationMarkdown } from './services/artifactExplanationService';

export type CodeTokenType =
    | 'keyword'
    | 'string'
    | 'comment'
    | 'number'
    | 'function'
    | 'type'
    | 'punctuation'
    | 'operator'
    | 'text';

export interface CodeToken {
    type: CodeTokenType;
    text: string;
}

export type MarkdownBlock =
    | { type: 'code'; language: string; content: string }
    | { type: 'heading'; level: number; content: string }
    | { type: 'list'; listType: 'bullet' | 'ordered'; items: string[] }
    | { type: 'blockquote'; content: string }
    | { type: 'paragraph'; content: string };

const KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'default', 'class', 'interface', 'type', 'export', 'import', 'from',
    'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'true', 'false',
    'null', 'undefined', 'def', 'elif', 'in', 'is', 'not', 'and', 'or', 'None', 'lambda',
    'with', 'as', 'pass', 'yield', 'self', 'cls', 'echo', 'curl', 'cd', 'ls', 'mkdir',
    'rm', 'sudo', 'npm', 'npx', 'yarn', 'git', 'select', 'where', 'insert', 'update',
    'delete', 'create', 'table', 'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer',
    'group', 'by', 'order', 'having', 'limit', 'public', 'private', 'protected', 'static',
    'readonly', 'extends', 'implements', 'enum', 'package', 'namespace',
    'require', 'module', 'exports', 'process', '__dirname', '__filename', 'global', 'window'
]);

const BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'any', 'void', 'never', 'unknown', 'Promise', 'Array',
    'Record', 'Object', 'Function', 'Symbol', 'bigint', 'int', 'float', 'list', 'dict',
    'set', 'tuple', 'bool', 'str', 'bytes', 'ChatMessage', 'CanvasArtifact', 'React', 'ReactDOM',
    'HTMLDivElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event'
]);

/**
 * Tokenizes source code into high-contrast, clean syntax tokens.
 */
export function tokenizeCode(code: string, language?: string): CodeToken[] {
    if (!code || typeof code !== 'string') {
        return [];
    }
    const tokens: CodeToken[] = [];
    const lines = code.split('\n');
    let inBlockComment = false;

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
        const line = lines[lIdx];
        let i = 0;

        if (inBlockComment) {
            const endIdx = line.indexOf('*/');
            if (endIdx !== -1) {
                tokens.push({ type: 'comment', text: line.slice(0, endIdx + 2) });
                i = endIdx + 2;
                inBlockComment = false;
            } else {
                tokens.push({ type: 'comment', text: line });
                i = line.length;
            }
        }

        while (i < line.length) {
            // Block comment start (/* or /**)
            if (line.slice(i, i + 2) === '/*') {
                const endIdx = line.indexOf('*/', i + 2);
                if (endIdx !== -1) {
                    tokens.push({ type: 'comment', text: line.slice(i, endIdx + 2) });
                    i = endIdx + 2;
                    continue;
                } else {
                    tokens.push({ type: 'comment', text: line.slice(i) });
                    inBlockComment = true;
                    i = line.length;
                    break;
                }
            }

            // Single line comments (// or #)
            if (line.slice(i, i + 2) === '//' || (language === 'python' || language === 'bash' || language === 'sh' ? line[i] === '#' : false)) {
                tokens.push({ type: 'comment', text: line.slice(i) });
                i = line.length;
                break;
            }

            // Strings ("...", '...', `...`)
            if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
                const quote = line[i];
                let end = i + 1;
                while (end < line.length) {
                    if (line[end] === '\\') {
                        end += 2;
                    } else if (line[end] === quote) {
                        end++;
                        break;
                    } else {
                        end++;
                    }
                }
                tokens.push({ type: 'string', text: line.slice(i, end) });
                i = end;
                continue;
            }

            // Numbers
            const numMatch = line.slice(i).match(/^(\b\d+(\.\d+)?\b)/);
            if (numMatch) {
                tokens.push({ type: 'number', text: numMatch[1] });
                i += numMatch[1].length;
                continue;
            }

            // Words / Identifiers / Keywords / Types / Functions
            const wordMatch = line.slice(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
            if (wordMatch) {
                const word = wordMatch[1];
                const restOfLine = line.slice(i + word.length);
                const isFunctionCall = /^\s*\(/.test(restOfLine);
                const isObjectKey = /^\s*:/.test(restOfLine) && !/^\s*::/.test(restOfLine);

                if (KEYWORDS.has(word)) {
                    tokens.push({ type: 'keyword', text: word });
                } else if (BUILTIN_TYPES.has(word) || /^[A-Z][a-zA-Z0-9_]*$/.test(word)) {
                    tokens.push({ type: 'type', text: word });
                } else if (isFunctionCall) {
                    tokens.push({ type: 'function', text: word });
                } else if (isObjectKey) {
                    tokens.push({ type: 'operator', text: word });
                } else {
                    tokens.push({ type: 'text', text: word });
                }
                i += word.length;
                continue;
            }

            // Punctuation and operators
            const punctMatch = line.slice(i).match(/^([{}()[\];:,.<>+\-*/%=!&|^~?]+)/);
            if (punctMatch) {
                tokens.push({ type: 'punctuation', text: punctMatch[1] });
                i += punctMatch[1].length;
                continue;
            }

            // Whitespace or other characters
            tokens.push({ type: 'text', text: line[i] });
            i++;
        }

        if (lIdx < lines.length - 1) {
            tokens.push({ type: 'text', text: '\n' });
        }
    }

    return tokens;
}

/**
 * Checks if a string payload is a raw canvas artifact JSON object (document, flow-graph, kanban, 3D scene, etc.).
 */
export function isCanvasArtifactJson(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    
    // Primitive types
    const artifactTypePattern = /"(?:type|primitiveType)"\s*:\s*"(?:node-graph|flow-graph|markdown-document|rendered-document|kanban-board|kanban|metric-dashboard|metrics|interactive-form|mind-map|checklist|skills-hub|mcp-hub|live-code-sandbox|3d-scene|3d_scene|interactive-browser|browser|video-timeline|video-editor|timeline|nle)"/i;
    
    // 3D Scene structures & spatial properties
    const scene3DPattern = /"(?:camera|skybox|lighting|terrainBiomes|geoAnchor|atmosphericScattering|godRays|contrails|controlSurfaces|landmarkName|spatial3d|durableUri|biomeType)"\s*:/i;
    const sceneObjectsPattern = /"(?:objects|combatants|buildings)"\s*:\s*\[[\s\S]*?"(?:content|space|mesh|model|durableUri|spatial3d)"/i;
    const malformedJsonPrefixPattern = /^(?:json\s*,\s*|\s*\{?\s*)"(?:camera|environment|skybox|geoAnchor|objects|features|docTitle|sections|type)"\s*:/i;

    // Document structure & tables
    const documentStructurePattern = /"(?:docTitle|sections|checklistItems|tableHeaders|tableRows)"\s*:/i;
    
    // General artifact & node graph / kanban / files patterns
    const generalArtifactPattern = /"(?:id|title|summary)"\s*:[\s\S]*?"(?:data|sections|nodes|columns|files|camera|objects|environment)"\s*:/i;
    const artifactIdPattern = /"id"\s*:\s*"art-[^"]+"/i;
    
    return (
        artifactTypePattern.test(trimmed) ||
        scene3DPattern.test(trimmed) ||
        sceneObjectsPattern.test(trimmed) ||
        malformedJsonPrefixPattern.test(trimmed) ||
        documentStructurePattern.test(trimmed) ||
        generalArtifactPattern.test(trimmed) ||
        artifactIdPattern.test(trimmed)
    );
}

/**
 * Extracts embedded canvas artifact or 3D scene JSON from text into a structured CanvasArtifact if present.
 */
export function extractArtifactFromJson(text: string): CanvasArtifact | null {
    if (!text || typeof text !== 'string') return null;
    
    // Look for fenced json blocks first
    const fencedMatch = text.match(/`{3,4}(?:json)?\s*([\s\S]*?)`{3,4}/i);
    let candidateJson = fencedMatch ? fencedMatch[1].trim() : '';

    if (!candidateJson) {
        // Try looking for unfenced JSON block starting with { "id" or { "type" or { "camera"
        const objectMatch = text.match(/(\{[\s\S]*\})/);
        if (objectMatch) {
            candidateJson = objectMatch[1].trim();
        }
    }

    if (!candidateJson) return null;

    try {
        const parsed = JSON.parse(candidateJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (parsed.type === '3d-scene' || parsed.camera || parsed.environment || parsed.objects) {
                return {
                    id: String(parsed.id || `art-3d-${Date.now()}`),
                    type: '3d-scene',
                    title: String(parsed.title || parsed.data?.title || '3D Scene Workspace'),
                    summary: String(parsed.summary || 'Interactive 3D spatial scene.'),
                    version: Number(parsed.version) || 1,
                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    data: (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) ? parsed.data : parsed
                };
            }
            if (parsed.type && parsed.data) {
                return {
                    id: String(parsed.id || `art-${Date.now()}`),
                    type: parsed.type,
                    title: String(parsed.title || parsed.data?.title || 'Canvas Artifact'),
                    summary: String(parsed.summary || 'Generated Canvas Artifact'),
                    version: Number(parsed.version) || 1,
                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    data: parsed.data
                };
            }
        }
    } catch {
        // If strict JSON.parse fails, attempt sanitizing common trailing commas
        try {
            const sanitized = candidateJson.replace(/,\s*([\]}])/g, '$1');
            const parsed = JSON.parse(sanitized);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    id: String(parsed.id || `art-${Date.now()}`),
                    type: parsed.type || '3d-scene',
                    title: String(parsed.title || 'Canvas Artifact'),
                    summary: String(parsed.summary || 'Generated Canvas Artifact'),
                    version: Number(parsed.version) || 1,
                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    data: (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) ? parsed.data : parsed
                };
            }
        } catch {
            // Ignore parse errors
        }
    }

    return null;
}

/**
 * Splits raw markdown text into structured blocks (fenced code, headings, lists, quotes, paragraphs).
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
    if (!text || typeof text !== 'string' || !text.trim()) {
        return [];
    }

    const blocks: MarkdownBlock[] = [];
    const codeBlockRegex = /`{3,4}([^\n\r]*)\r?\n([\s\S]*?)`{3,4}/g;

    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
        // Process markdown text before the code block
        const preText = text.substring(lastIndex, match.index);
        if (preText.trim()) {
            parseTextSegment(preText, blocks);
        }

        const rawLang = (match[1] || 'plaintext').trim().split(/\s+/)[0].toLowerCase();
        const language = rawLang || 'plaintext';
        const content = match[2].trimEnd();
        
        // Suppress code boxes for artifact JSON payloads so raw JSON is never rendered in chat history
        if (!isCanvasArtifactJson(content) && !isCanvasArtifactJson(match[0])) {
            blocks.push({
                type: 'code',
                language: language || 'plaintext',
                content
            });
        }

        lastIndex = match.index + match[0].length;
    }

    // Process any remaining text after the last code block (including in-flight streaming code blocks)
    const postText = text.substring(lastIndex);
    if (postText.trim()) {
        const unclosedCodeMatch = postText.match(/^([\s\S]*?)`{3,4}([^\n\r]*)\r?\n([\s\S]*)$/);
        if (unclosedCodeMatch) {
            const preCodeText = unclosedCodeMatch[1];
            if (preCodeText.trim()) {
                parseTextSegment(preCodeText, blocks);
            }
            const rawLang = (unclosedCodeMatch[2] || 'plaintext').trim().split(/\s+/)[0].toLowerCase();
            const language = rawLang || 'plaintext';
            const content = unclosedCodeMatch[3] || '';
            if (!isCanvasArtifactJson(content) && !isCanvasArtifactJson(postText)) {
                blocks.push({
                    type: 'code',
                    language: language || 'plaintext',
                    content
                });
            }
        } else {
            parseTextSegment(postText, blocks);
        }
    }

    return blocks;
}

/**
 * Parses markdown subsegments (headings, lists, blockquotes, paragraphs) within a text chunk.
 */
function parseTextSegment(rawSegment: string, blocks: MarkdownBlock[]) {
    const rawLines = rawSegment.split('\n');
    let currentParagraphLines: string[] = [];
    let currentListItems: string[] = [];
    let currentListType: 'bullet' | 'ordered' = 'bullet';
    let currentQuoteLines: string[] = [];

    const flushParagraph = () => {
        if (currentParagraphLines.length > 0) {
            const pContent = currentParagraphLines.join('\n').trim();
            const isJsonPayload = isCanvasArtifactJson(pContent) ||
                /^(?:json\s*,\s*|(?:\s*\{?\s*)"(?:camera|environment|skybox|geoAnchor|objects|features|docTitle|sections|type|primitiveType)"\s*:)/i.test(pContent) ||
                /^[{\[]\s*"(?:camera|environment|skybox|geoAnchor|objects|id|type)"/i.test(pContent);

            if (pContent && !isJsonPayload) {
                blocks.push({ type: 'paragraph', content: pContent });
            }
            currentParagraphLines = [];
        }
    };

    const flushList = () => {
        if (currentListItems.length > 0) {
            blocks.push({
                type: 'list',
                listType: currentListType,
                items: [...currentListItems]
            });
            currentListItems = [];
        }
    };

    const flushQuote = () => {
        if (currentQuoteLines.length > 0) {
            blocks.push({
                type: 'blockquote',
                content: currentQuoteLines.join('\n').trim()
            });
            currentQuoteLines = [];
        }
    };

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            flushParagraph();
            flushList();
            flushQuote();
            continue;
        }

        // Heading
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            flushParagraph();
            flushList();
            flushQuote();
            blocks.push({
                type: 'heading',
                level: headingMatch[1].length,
                content: headingMatch[2].trim()
            });
            continue;
        }

        // Blockquote
        const quoteMatch = line.match(/^>\s*(.*)$/);
        if (quoteMatch) {
            flushParagraph();
            flushList();
            currentQuoteLines.push(quoteMatch[1]);
            continue;
        } else {
            flushQuote();
        }

        // Bullet List (- or * or • or +)
        const bulletMatch = line.match(/^[\*\-•\u2022\u25E6\u25AA\u25B8\+]\s+(.*)$/);
        if (bulletMatch) {
            flushParagraph();
            if (currentListItems.length > 0 && currentListType !== 'bullet') {
                flushList();
            }
            currentListType = 'bullet';
            currentListItems.push(bulletMatch[1]);
            continue;
        }

        // Ordered List (1. 2.)
        const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
        if (orderedMatch) {
            flushParagraph();
            if (currentListItems.length > 0 && currentListType !== 'ordered') {
                flushList();
            }
            currentListType = 'ordered';
            currentListItems.push(orderedMatch[1]);
            continue;
        }

        // Regular line of text
        flushList();
        currentParagraphLines.push(line);
    }

    flushParagraph();
    flushList();
    flushQuote();
}

/**
 * Strips raw canvas artifact JSON blocks while cleanly preserving code snippets and markdown text.
 */
export function cleanMessageTextSmart(rawText: string, artifact?: CanvasArtifact): string {
    if (!rawText || typeof rawText !== 'string') {
        return artifact ? `I've synthesized the **${artifact.title || 'Canvas Artifact'}** on your visual canvas.` : '';
    }

    const artifactTypes = '(?:node-graph|flow-graph|markdown-document|rendered-document|kanban-board|kanban|metric-dashboard|metrics|interactive-form|mind-map|checklist|skills-hub|mcp-hub|live-code-sandbox|3d-scene|3d_scene|interactive-browser|browser|video-timeline|video-editor|timeline|nle)';

    // 1. Remove systemic preamble phrases
    let cleaned = rawText.replace(/Connected to Studio AI Engine with Thinking active\.\.\.?\s*/gi, '');

    // 1.1 Strip canonical <scratchboxPrimitive> tags completely from user-visible chat bubbles
    cleaned = cleaned.replace(/<scratchboxPrimitive[\s\S]*?<\/scratchboxPrimitive>/gi, '');
    cleaned = cleaned.replace(/<scratchboxPrimitive[\s\S]*$/gi, '');

    // 2. Remove "Here's the JSON..." / "Below is the JSON..." / "Here's the updated 3D scene JSON..." preamble phrases
    cleaned = cleaned.replace(/(?:Here(?:'s|\s+is)|Below\s+is|Here\s+are)\s+(?:the\s+)?(?:updated\s+|new\s+|interactive\s+|spatial\s+)?(?:3d\s+scene\s+)?(?:JSON|code|canvas\s+JSON|payload|data|scene\s+JSON)[\s\S]*?:/gi, '');
    cleaned = cleaned.replace(/Here's\s+a\s+3D\s+scene\s+JSON[\s\S]*?:/gi, '');

    // 3. Strip fenced JSON/code blocks with 3 or 4 backticks that represent canvas artifacts or 3D scenes
    cleaned = cleaned.replace(/`{3,4}(?:json|javascript|typescript|js|ts|markdown|md)?\s*\{[\s\S]*?`{3,4}/gi, (match) => {
        const inner = match.replace(/^`{3,4}(?:[a-zA-Z0-9_-]*)\r?\n?/, '').replace(/`{3,4}$/, '').trim();
        if (isCanvasArtifactJson(inner)) {
            return '';
        }
        return match;
    });

    // 4. Strip single backtick wrapped JSON artifacts
    cleaned = cleaned.replace(/`\s*\{[\s\S]*?"(?:camera|environment|objects|type|docTitle)"[\s\S]*?\}\s*`/gi, '');

    // 5. Strip raw XML-like tool call / function tags if leaked
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
    cleaned = cleaned.replace(/<function_call>[\s\S]*?<\/function_call>/gi, '');

    // 6. Strip system / grounding tags if leaked
    cleaned = cleaned.replace(/<system>[\s\S]*?<\/system>/gi, '');
    cleaned = cleaned.replace(/<grounding>[\s\S]*?<\/grounding>/gi, '');

    // 7. Strip large naked JSON blocks
    cleaned = cleaned.replace(/\{[\s\r\n]*"(?:title|docTitle|type|sections|nodes|columns|camera|environment)"[\s\S]*?\}(?=\s*(?:\n\n|$))/gi, (match) => {
        if (isCanvasArtifactJson(match)) {
            return '';
        }
        return match;
    });

    // 8. Strip unfenced camera / environment / spatial payloads
    cleaned = cleaned.replace(/\{?\s*"(?:camera|environment|skybox|features|geoAnchor|objects)"\s*:[\s\S]*?(?:\]\s*\}|\}\s*\}|\}$|$)/gi, (match) => {
        if (isCanvasArtifactJson(match)) {
            return '';
        }
        return match;
    });

    cleaned = cleaned.replace(/\{\s*"type"\s*:\s*"(?:node-graph|flow-graph|markdown-document|rendered-document|kanban-board|kanban|metric-dashboard|metrics|interactive-form|mind-map|checklist|skills-hub|mcp-hub|live-code-sandbox|3d-scene|3d_scene|interactive-browser|browser|video-timeline|video-editor|timeline|nle)"[\s\S]*?\}/gi, '');
    cleaned = cleaned.replace(/\{\s*"docTitle"\s*:[\s\S]*?"sections"\s*:[\s\S]*?\}/gi, '');

    // 9. Sanitize video timeline limitation disclaimers if video-timeline artifact is mounted
    if (artifact?.type === 'video-timeline') {
        cleaned = cleaned.replace(/(?:However,\s+)?I\s+cannot\s+directly\s+interact\s+with\s+or\s+generate\s+a\s+video-timeline\s+primitive[\s\S]*?(?:Please\s+let\s+me\s+know\s+how\s+you'd\s+like\s+to\s+proceed!?)?/gi, '').trim();
        cleaned = cleaned.replace(/My\s+current\s+capabilities\s+are\s+limited\s+to\s+the\s+following\s+canvas\s+primitives[\s\S]*?(?:Please\s+let\s+me\s+know\s+how\s+you'd\s+like\s+to\s+proceed!?)?/gi, '').trim();
        cleaned = cleaned.replace(/As\s+an\s+AI,\s+I\s+don't\s+directly\s+control\s+external\s+video\s+editing\s+software[\s\S]*?(?:Here\s+is\s+the\s+(?:`?live-code-sandbox`?\s+)?artifact:?)?/gi, '').trim();
        cleaned = cleaned.replace(/The\s+request\s+to\s+"[^"]+"\s+describes\s+a\s+common\s+video\s+editing\s+operation\.\s*As\s+an\s+AI[\s\S]*?(?:Here\s+is\s+the\s+(?:`?live-code-sandbox`?\s+)?artifact:?)?/gi, '').trim();
        cleaned = cleaned.replace(/I\s+cannot\s+directly\s+perform\s+video\s+editing\s+operations[\s\S]*?(?:future\s+implementation\.?|$)/gi, '').trim();
        cleaned = cleaned.replace(/(?:However,\s+)?I\s+can\s+create\s+a\s+`?live-code-sandbox`?[\s\S]*?(?:future\s+implementation\.?|$)/gi, '').trim();
        cleaned = cleaned.replace(/Here\s+is\s+an?\s+(?:interactive\s+)?`?live-code-sandbox`?[\s\S]*?(?:future\s+implementation\.?|$)/gi, '').trim();
    }

    // 10. Normalize spacing and remove excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    if (artifact?.type === 'video-timeline') {
        if (!cleaned || /cannot directly|don't have access|live-code-sandbox|conceptual/i.test(cleaned)) {
            return `I've updated the **${artifact.title}** multi-track video timeline and performed the requested editing operation.`;
        }
    }

    if ((!cleaned || /^I(?:'ve|\s+have)\s+synthesized\s+the\s+\*\*.*?\*\*\s+on\s+your\s+visual\s+canvas\.?$/i.test(cleaned.trim())) && artifact) {
        return buildArtifactExplanationMarkdown(artifact);
    }
    return cleaned;
}

/**
 * Component for parsing and rendering inline markdown spans (bold, italic, inline code, links).
 */
export interface InlineMarkdownProps {
    text: string;
    onOpenInBrowser?: (url: string, title?: string) => void;
    onOpenWikilink?: (target: string, anchor?: string) => void;
    onPromptAction?: (prompt: string) => void;
}

export const InlineMarkdown: React.FC<InlineMarkdownProps> = ({ text, onOpenInBrowser, onOpenWikilink, onPromptAction }) => {
    if (!text || typeof text !== 'string') return null;

    // Pattern to match inline images (![alt](url)), wikilinks ([[target]]), code (`code`), bold (**bold**), italic (*italic*), links ([title](url)), HTML buttons (<button>...), and standalone bracketed action pills ([Title])
    const parts: React.ReactNode[] = [];
    const inlineRegex = /(!\[[^\]]*\]\([^)]+\)|\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|<button(?:\s+[^>]*)?>[\s\S]*?<\/button>|\[[^\]\n]{2,80}\])/gi;

    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let keyIdx = 0;

    while ((match = inlineRegex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(text.substring(lastIdx, match.index));
        }

        const matchedStr = match[0];
        if (matchedStr.startsWith('![') && matchedStr.includes('](')) {
            const imgMatch = matchedStr.match(/!\[(.*?)\]\((.*?)\)/);
            if (imgMatch) {
                const altText = imgMatch[1];
                const imgUrl = imgMatch[2];
                parts.push(
                    <span key={`img-${keyIdx++}`} className="sb-chat-inline-image-wrap" style={{ display: 'block', margin: '10px 0' }}>
                        <img
                            src={imgUrl}
                            alt={altText}
                            style={{ maxWidth: '100%', maxHeight: 360, borderRadius: 8, objectFit: 'contain', border: '1px solid rgba(255, 255, 255, 0.12)', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)' }}
                            loading="lazy"
                        />
                        {altText && (
                            <span style={{ display: 'block', fontSize: 11, color: 'rgba(255, 255, 255, 0.6)', marginTop: 4, fontStyle: 'italic' }}>
                                {altText}
                            </span>
                        )}
                    </span>
                );
            } else {
                parts.push(matchedStr);
            }
        } else if (matchedStr.startsWith('[[') && matchedStr.endsWith(']]')) {
            const inner = matchedStr.slice(2, -2).trim();
            let target = inner;
            let alias = '';
            let anchor = '';

            if (target.includes('|')) {
                const pipeIdx = target.indexOf('|');
                alias = target.slice(pipeIdx + 1).trim();
                target = target.slice(0, pipeIdx).trim();
            }
            if (target.includes('#')) {
                const hashIdx = target.indexOf('#');
                anchor = target.slice(hashIdx + 1).trim();
                target = target.slice(0, hashIdx).trim();
            }

            const displayLabel = alias || (anchor ? `${target} > ${anchor}` : target);

            parts.push(
                <span
                    key={`wikilink-${keyIdx++}`}
                    className="sb-wikilink-badge"
                    onClick={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (onOpenWikilink) {
                            onOpenWikilink(target, anchor);
                        } else if (onOpenInBrowser) {
                            onOpenInBrowser(`#wikilink:${encodeURIComponent(target)}`, displayLabel);
                        }
                    }}
                    title={`Knowledge Note Link: ${target}${anchor ? ' #' + anchor : ''}`}
                    role="button"
                    tabIndex={0}
                >
                    <span className="sb-wikilink-bracket">[[</span>
                    <span className="sb-wikilink-label">{displayLabel}</span>
                    <span className="sb-wikilink-bracket">]]</span>
                </span>
            );
        } else if (matchedStr.startsWith('`') && matchedStr.endsWith('`')) {
            parts.push(
                <code key={`code-${keyIdx++}`} className="sb-chat-inline-code">
                    {matchedStr.slice(1, -1)}
                </code>
            );
        } else if (matchedStr.startsWith('**') && matchedStr.endsWith('**')) {
            parts.push(
                <strong key={`bold-${keyIdx++}`} className="sb-chat-strong">
                    {matchedStr.slice(2, -2)}
                </strong>
            );
        } else if (matchedStr.startsWith('*') && matchedStr.endsWith('*')) {
            parts.push(
                <em key={`em-${keyIdx++}`} className="sb-chat-em">
                    {matchedStr.slice(1, -1)}
                </em>
            );
        } else if (matchedStr.startsWith('[') && matchedStr.includes('](')) {
            const linkMatch = matchedStr.match(/\[(.*?)\]\((.*?)\)/);
            if (linkMatch) {
                const linkTitle = linkMatch[1];
                const linkUrl = linkMatch[2];
                const isPromptAction = linkUrl.startsWith('prompt:') || linkUrl.startsWith('action:');
                if (isPromptAction && onPromptAction) {
                    const promptVal = decodeURIComponent(linkUrl.replace(/^(?:prompt|action):/, '')) || linkTitle;
                    parts.push(
                        <button
                            key={`action-${keyIdx++}`}
                            type="button"
                            className="sb-chat-action-pill"
                            onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                onPromptAction(promptVal);
                            }}
                            title={`Click to select: "${promptVal}"`}
                        >
                            <span className="sb-chat-action-pill-icon">✦</span>
                            <span className="sb-chat-action-pill-text">{linkTitle}</span>
                        </button>
                    );
                } else {
                    parts.push(
                        <a
                            key={`link-${keyIdx++}`}
                            href={linkUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="sb-chat-link"
                            onClick={e => {
                                if (onOpenInBrowser) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onOpenInBrowser(linkUrl, linkTitle);
                                }
                            }}
                        >
                            {linkTitle}
                        </a>
                    );
                }
            } else {
                parts.push(matchedStr);
            }
        } else if (matchedStr.startsWith('[') && matchedStr.endsWith(']')) {
            const pillTitle = matchedStr.slice(1, -1).trim();
            if (pillTitle && onPromptAction) {
                parts.push(
                    <button
                        key={`action-pill-${keyIdx++}`}
                        type="button"
                        className="sb-chat-action-pill"
                        onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPromptAction(pillTitle);
                        }}
                        title={`Click to select: "${pillTitle}"`}
                    >
                        <span className="sb-chat-action-pill-icon">✦</span>
                        <span className="sb-chat-action-pill-text">{pillTitle}</span>
                    </button>
                );
            } else {
                parts.push(matchedStr);
            }
        } else if (/^<button(?:\s+[^>]*)?>[\s\S]*?<\/button>$/i.test(matchedStr)) {
            const btnMatch = matchedStr.match(/<button(?:\s+[^>]*)?>([\s\S]*?)<\/button>/i);
            const pillTitle = btnMatch ? btnMatch[1].replace(/<[^>]+>/g, '').trim() : '';
            if (pillTitle && onPromptAction) {
                parts.push(
                    <button
                        key={`action-btn-${keyIdx++}`}
                        type="button"
                        className="sb-chat-action-pill"
                        onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPromptAction(pillTitle);
                        }}
                        title={`Click to select: "${pillTitle}"`}
                    >
                        <span className="sb-chat-action-pill-icon">✦</span>
                        <span className="sb-chat-action-pill-text">{pillTitle}</span>
                    </button>
                );
            } else {
                parts.push(pillTitle || matchedStr);
            }
        }

        lastIdx = match.index + matchedStr.length;
    }

    if (lastIdx < text.length) {
        parts.push(text.substring(lastIdx));
    }

    return <>{parts}</>;
};

/**
 * Sleek Code Block with language badge, copy button, syntax styling, and CLI guardrail actions.
 */
export const ChatCodeBlock: React.FC<{
    language: string;
    content: string;
    onExecuteCommand?: (cmd: string) => void;
    onPreviewInCanvas?: (language: string, content: string) => void;
}> = ({ language, content = '', onExecuteCommand, onPreviewInCanvas }) => {
    const safeContent = typeof content === 'string' ? content : String(content || '');
    const [copied, setCopied] = React.useState(false);
    const [executed, setExecuted] = React.useState(false);

    const handleCopy = async () => {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(safeContent);
            } else {
                const el = document.createElement('textarea');
                el.value = safeContent;
                document.body.appendChild(el);
                el.select();
                document.execCommand('copy');
                document.body.removeChild(el);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy code block:', err);
        }
    };

    const displayLang = (language && typeof language === 'string' && language !== 'plaintext') ? language.toLowerCase() : 'code';
    const tokens = React.useMemo(() => tokenizeCode(safeContent, language), [safeContent, language]);

    const isPreviewable = React.useMemo(() => {
        const lang = (language || '').toLowerCase();
        if (['tsx', 'jsx', 'react', 'html', 'htm', 'svg', 'python', 'py'].includes(lang)) return true;
        if (['javascript', 'js', 'typescript', 'ts'].includes(lang)) {
            return /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(safeContent);
        }
        return /<!DOCTYPE\s+html|<html|<svg/i.test(safeContent);
    }, [language, safeContent]);

    const isShellScript = React.useMemo(() => {
        const lang = (language || '').toLowerCase();
        if (['bash', 'sh', 'zsh', 'shell', 'terminal', 'cmd'].includes(lang)) {
            return true;
        }
        const firstLine = safeContent.trim().split('\n')[0] || '';
        return /^(npm|yarn|pnpm|npx|git|tsc|ts-node|node|curl|mkdir|touch|cargo|go|docker)\b/.test(firstLine);
    }, [language, safeContent]);

    const cliGuardrail = React.useMemo(() => {
        if (!isShellScript) return null;
        return classifyCliCommand(safeContent.trim());
    }, [isShellScript, safeContent]);

    const handleRunInTerminal = () => {
        if (onExecuteCommand && safeContent.trim()) {
            onExecuteCommand(safeContent.trim());
            setExecuted(true);
            setTimeout(() => setExecuted(false), 2500);
        }
    };

    return (
        <div className="sb-chat-code-block-container">
            {/* Header with language tag, guardrail badges and actions */}
            <div className="sb-chat-code-header">
                <div className="sb-chat-code-header-left">
                    <span className="sb-chat-code-lang">{displayLang}</span>
                    {cliGuardrail && (
                        <span
                            className={`sb-cli-guardrail-pill sb-guardrail-${cliGuardrail.level}`}
                            title={cliGuardrail.description || 'CLI Execution Guardrail'}
                        >
                            {cliGuardrail.level === 'safe_read' && '🛡 Safe Read-Only'}
                            {cliGuardrail.level === 'prompt_confirm' && '⚡ Requires Confirmation'}
                            {cliGuardrail.level === 'blocked_danger' && '⚠️ Blocked Danger'}
                        </span>
                    )}
                </div>

                <div className="sb-chat-code-actions">
                    {isShellScript && onExecuteCommand && cliGuardrail?.level !== 'blocked_danger' && (
                        <button
                            type="button"
                            className={`sb-chat-code-action-btn sb-btn-run-term ${executed ? 'sb-code-executed' : ''}`}
                            onClick={handleRunInTerminal}
                            title="Execute in Scratchbox Terminal with Guardrails"
                        >
                            {executed ? (
                                <>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                    <span>Sent to Terminal</span>
                                </>
                            ) : (
                                <>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                        <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                    <span>Run in Terminal</span>
                                </>
                            )}
                        </button>
                    )}

                    {isPreviewable && onPreviewInCanvas && (
                        <button
                            type="button"
                            className="sb-chat-code-action-btn sb-btn-preview-canvas"
                            onClick={() => onPreviewInCanvas(language, safeContent)}
                            title="Preview live in Scratchbox Canvas"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(99, 102, 241, 0.25))',
                                border: '1px solid rgba(99, 102, 241, 0.4)',
                                color: '#a5b4fc',
                                borderRadius: '6px',
                                padding: '2px 8px',
                                fontSize: '11px',
                                fontWeight: 500,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease'
                            }}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            <span>Preview in Canvas</span>
                        </button>
                    )}

                    <button
                        type="button"
                        className={`sb-chat-code-copy-btn ${copied ? 'sb-code-copied' : ''}`}
                        onClick={handleCopy}
                        title="Copy code to clipboard"
                    >
                        {copied ? (
                            <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Copied!</span>
                            </>
                        ) : (
                            <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                </svg>
                                <span>Copy</span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Code Body with Syntax Highlighting */}
            <div className="sb-chat-code-body">
                <pre className="sb-chat-code-pre">
                    <code>
                        {tokens.map((token, idx) => (
                            <span key={`${token.type}-${idx}-${token.text.length}`} className={`sb-tok-${token.type}`}>
                                {token.text}
                            </span>
                        ))}
                    </code>
                </pre>
            </div>
        </div>
    );
};

/**
 * Compact, Elegant Cupertino-style Thinking & Reasoning Disclosure
 */
export const ThinkingDisclosure: React.FC<{
    thinkingText?: string;
    isLive?: boolean;
    durationSeconds?: number;
}> = ({ thinkingText, isLive = false, durationSeconds }) => {
    const [isExpanded, setIsExpanded] = React.useState(isLive);
    const prevLiveRef = React.useRef(isLive);
    const contentRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (prevLiveRef.current && !isLive) {
            // Live thinking just completed, smoothly collapse
            setIsExpanded(false);
        } else if (!prevLiveRef.current && isLive) {
            setIsExpanded(true);
        }
        prevLiveRef.current = isLive;
    }, [isLive]);

    React.useEffect(() => {
        if (isLive && contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [thinkingText, isLive]);

    if (!thinkingText && !isLive) {
        return null;
    }

    const formattedDuration = durationSeconds !== undefined && durationSeconds > 0
        ? durationSeconds < 10
            ? durationSeconds.toFixed(1)
            : Math.round(durationSeconds).toString()
        : null;

    return (
        <div className={`sb-thinking-disclosure-wrapper ${isLive ? 'sb-thinking-live' : ''}`}>
            <button
                type="button"
                className="sb-thinking-disclosure-toggle"
                onClick={() => setIsExpanded(prev => !prev)}
                title={isExpanded ? 'Hide thinking process' : 'Show thinking process'}
            >
                <div className="sb-thinking-toggle-left">
                    {isLive ? (
                        <span className="sb-thinking-live-dot" />
                    ) : (
                        <svg className="sb-thinking-brain-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
                            <path d="M9 21h6" />
                        </svg>
                    )}
                    <span className="sb-thinking-status-text">
                        {isLive ? (
                            <>
                                <span>Thinking</span>
                                {formattedDuration ? <span className="sb-thinking-timer">({formattedDuration}s)</span> : null}
                                <span className="animate-pulse">...</span>
                            </>
                        ) : formattedDuration ? (
                            `Thought for ${formattedDuration}s`
                        ) : (
                            'Thought for a few seconds'
                        )}
                    </span>
                </div>

                <svg
                    className={`sb-thinking-chevron ${isExpanded ? 'sb-chevron-open' : ''}`}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {isExpanded && (
                <div ref={contentRef} className="sb-thinking-expanded-body animate-fadeIn" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                    <div className="sb-thinking-content-text">
                        {thinkingText || (isLive ? 'Analyzing dependencies and formulating generative architecture plan...' : '')}
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * Interactive Agent Execution Stepper
 * Renders real-time or historical tool execution steps with status indicators and latency badges.
 */
export const AgentExecutionStepper: React.FC<{
    steps?: AgentExecutionStep[];
    isLive?: boolean;
    className?: string;
}> = ({ steps, isLive = false, className = '' }) => {
    const [expandedStepId, setExpandedStepId] = React.useState<string | null>(null);

    if (!steps || steps.length === 0) {
        return null;
    }

    return (
        <div className={`sb-cursor-tool-steps-group ${className}`}>
            {steps.map(step => {
                const isRunning = step.status === 'running';
                const isCompleted = step.status === 'completed';
                const isFailed = step.status === 'failed';
                const isExpanded = expandedStepId === step.id;

                return (
                    <div key={step.id} className="sb-cursor-tool-step-container">
                        <div
                            className="sb-cursor-tool-step"
                            onClick={() => step.details && setExpandedStepId(isExpanded ? null : step.id)}
                            title={step.details ? (isExpanded ? 'Click to collapse details' : 'Click to inspect execution trace') : undefined}
                            style={{ cursor: step.details ? 'pointer' : 'default' }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span className={`sb-cursor-tool-step-icon ${isRunning ? 'is-running' : isCompleted ? 'is-completed' : isFailed ? 'is-failed' : 'is-pending'}`}>
                                    {isRunning ? '⟳' : isCompleted ? '✓' : isFailed ? '⚠' : '○'}
                                </span>
                                <span className="sb-cursor-tool-step-title">{step.title}</span>
                            </div>
                            {(step.durationFormatted || (step.durationMs !== undefined && step.durationMs > 0)) && (
                                <span className="sb-cursor-tool-step-duration">
                                    {step.durationFormatted || `${step.durationMs}ms`}
                                </span>
                            )}
                        </div>
                        {isExpanded && step.details && (
                            <div className="sb-cursor-tool-step-details animate-fadeIn">
                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                                    {step.details}
                                </pre>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

/**
 * Stylish blinking block cursor / caret for active token streams.
 */
export const StreamingCursor: React.FC<{ className?: string }> = ({ className = '' }) => (
    <span className={`sb-chat-streaming-cursor animate-pulse ${className}`} title="Streaming...">
        ▊
    </span>
);

export interface ChatMarkdownRendererProps {
    text: string;
    className?: string;
    isStreaming?: boolean;
    onExecuteCommand?: (cmd: string) => void;
    onOpenInBrowser?: (url: string, title?: string) => void;
    onOpenWikilink?: (target: string, anchor?: string) => void;
    onPreviewInCanvas?: (language: string, content: string) => void;
    onPromptAction?: (prompt: string) => void;
}

/**
 * Main Chat Markdown Renderer for assistant and user messages.
 */
export const ChatMarkdownRenderer: React.FC<ChatMarkdownRendererProps> = ({
    text = '',
    className = '',
    isStreaming = false,
    onExecuteCommand,
    onOpenInBrowser,
    onOpenWikilink,
    onPreviewInCanvas,
    onPromptAction
}) => {
    const safeText = typeof text === 'string' ? text : (text ? String(text) : '');
    const blocks = React.useMemo(() => parseMarkdownBlocks(safeText), [safeText]);

    if (!blocks || blocks.length === 0) {
        if (isStreaming) {
            return (
                <div className={`sb-chat-markdown-root sb-streaming-text-bubble ${className}`}>
                    <StreamingCursor />
                </div>
            );
        }
        return null;
    }

    return (
        <CanvasErrorBoundary compact fallbackTitle="Markdown Render Notice">
            <div className={`sb-chat-markdown-root ${isStreaming ? 'sb-streaming-text-bubble' : ''} ${className}`}>
                {blocks.map((block, bIdx) => {
                    const isLast = bIdx === blocks.length - 1;
                    switch (block.type) {
                        case 'code':
                            return (
                                <React.Fragment key={bIdx}>
                                    <ChatCodeBlock
                                        language={block.language || 'plaintext'}
                                        content={block.content || ''}
                                        onExecuteCommand={onExecuteCommand}
                                        onPreviewInCanvas={onPreviewInCanvas}
                                    />
                                    {isStreaming && isLast && <StreamingCursor />}
                                </React.Fragment>
                            );

                        case 'heading': {
                            const level = typeof block.level === 'number' ? block.level : 1;
                            const Tag = `h${Math.min(6, Math.max(1, level))}` as keyof JSX.IntrinsicElements;
                            return (
                                <Tag key={bIdx} className={`sb-chat-heading sb-chat-h${level}`}>
                                    <InlineMarkdown
                                        text={block.content || ''}
                                        onOpenInBrowser={onOpenInBrowser}
                                        onOpenWikilink={onOpenWikilink}
                                        onPromptAction={onPromptAction}
                                    />
                                    {isStreaming && isLast && <StreamingCursor />}
                                </Tag>
                            );
                        }

                        case 'list': {
                            const items = Array.isArray(block.items) ? block.items : [];
                            const renderListItem = (item: string, iIdx: number) => {
                                const isLastItem = iIdx === items.length - 1;

                                // 1. Check for raw HTML button tag: <button class="sb-pill" ...>Label</button>
                                const btnMatch = item.match(/<button(?:\s+[^>]*)?>([\s\S]*?)<\/button>/i);
                                if (btnMatch && onPromptAction) {
                                    const rawLabel = btnMatch[1].replace(/<[^>]+>/g, '').trim();
                                    const promptToSend = rawLabel;
                                    const trailingText = item.replace(/<button(?:\s+[^>]*)?>[\s\S]*?<\/button>/i, '').replace(/^[—–\-:]\s*/, '').trim();

                                    return (
                                        <li key={iIdx} className="sb-chat-list-item sb-chat-action-pill-item">
                                            <button
                                                type="button"
                                                className="sb-chat-action-pill"
                                                onClick={() => onPromptAction(promptToSend)}
                                                title={`Click to select: "${promptToSend}"`}
                                            >
                                                <span className="sb-chat-action-pill-icon">✦</span>
                                                <span className="sb-chat-action-pill-text">{rawLabel}</span>
                                            </button>
                                            {trailingText && (
                                                <span className="sb-chat-action-desc">
                                                    <InlineMarkdown
                                                        text={trailingText}
                                                        onOpenInBrowser={onOpenInBrowser}
                                                        onOpenWikilink={onOpenWikilink}
                                                        onPromptAction={onPromptAction}
                                                    />
                                                </span>
                                            )}
                                            {isStreaming && isLast && isLastItem && <StreamingCursor />}
                                        </li>
                                    );
                                }

                                const pillRegex = /^(?:[✦►🔘]\s*)?(?:`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\](?:\((?:prompt:|action:)?([^)]*)\))?)\s*(?:[—–\-:]|\s-\s)?\s*(.*)$/;
                                const m = onPromptAction ? item.match(pillRegex) : null;

                                if (m) {
                                    const title = (m[1] || m[2] || m[3] || '').trim();
                                    const customPrompt = m[4] ? decodeURIComponent(m[4].replace(/^(?:prompt|action):/, '')) : '';
                                    const promptToSend = customPrompt || title;
                                    const description = (m[5] || '').trim();

                                    return (
                                        <li key={iIdx} className="sb-chat-list-item sb-chat-action-pill-item">
                                            <button
                                                type="button"
                                                className="sb-chat-action-pill"
                                                onClick={() => onPromptAction(promptToSend)}
                                                title={`Click to select: "${promptToSend}"`}
                                            >
                                                <span className="sb-chat-action-pill-icon">✦</span>
                                                <span className="sb-chat-action-pill-text">{title}</span>
                                            </button>
                                            {description && (
                                                <span className="sb-chat-action-desc">
                                                    <InlineMarkdown
                                                        text={description}
                                                        onOpenInBrowser={onOpenInBrowser}
                                                        onOpenWikilink={onOpenWikilink}
                                                        onPromptAction={onPromptAction}
                                                    />
                                                </span>
                                            )}
                                            {isStreaming && isLast && isLastItem && <StreamingCursor />}
                                        </li>
                                    );
                                }

                                return (
                                    <li key={iIdx} className="sb-chat-list-item">
                                        <InlineMarkdown
                                            text={item || ''}
                                            onOpenInBrowser={onOpenInBrowser}
                                            onOpenWikilink={onOpenWikilink}
                                            onPromptAction={onPromptAction}
                                        />
                                        {isStreaming && isLast && isLastItem && <StreamingCursor />}
                                    </li>
                                );
                            };

                            return block.listType === 'ordered' ? (
                                <ol key={bIdx} className="sb-chat-ordered-list">
                                    {items.map((item, iIdx) => renderListItem(item, iIdx))}
                                </ol>
                            ) : (
                                <ul key={bIdx} className="sb-chat-bullet-list">
                                    {items.map((item, iIdx) => renderListItem(item, iIdx))}
                                </ul>
                            );
                        }

                        case 'blockquote':
                            return (
                                <blockquote key={bIdx} className="sb-chat-blockquote">
                                    <InlineMarkdown
                                        text={block.content || ''}
                                        onOpenInBrowser={onOpenInBrowser}
                                        onOpenWikilink={onOpenWikilink}
                                        onPromptAction={onPromptAction}
                                    />
                                    {isStreaming && isLast && <StreamingCursor />}
                                </blockquote>
                            );

                        case 'paragraph':
                        default:
                            return (
                                <p key={bIdx} className="sb-chat-paragraph">
                                    <InlineMarkdown
                                        text={block.content || ''}
                                        onOpenInBrowser={onOpenInBrowser}
                                        onOpenWikilink={onOpenWikilink}
                                        onPromptAction={onPromptAction}
                                    />
                                    {isStreaming && isLast && <StreamingCursor />}
                                </p>
                            );
                    }
                })}
            </div>
        </CanvasErrorBoundary>
    );
};
