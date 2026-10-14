/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { DEFAULT_ACTIVE_USER_NAME,
    CanvasArtifact,
    GraphEdge,
    GraphNode,
    KanbanBoardData,
    KanbanCard,
    MarkdownDocumentData,
    MarkdownSection,
    NodeGraphData,
    getActiveUserName
} from '../canvas-types';
import {
    detectDocumentTheme,
    generateMotivatedLocationSection,
    generateMotivatedEditorialImageSection,
    generateMotivatedVideoSection,
    generateMotivatedSvgSection,
    generateMotivatedCitationSection,
    synthesizeComprehensiveDocument
} from '../document-synthesis-engine';
import {
    IconArrowDown,
    IconArrowUp,
    IconCallout,
    IconCheck,
    IconChecklist,
    IconCitation,
    IconClose,
    IconCode,
    IconCopy,
    IconDiagram,
    IconEdit,
    IconExternalLink,
    IconImage,
    IconKanban,
    IconPalette,
    IconPin,
    IconPlus,
    IconSparkles,
    IconTable,
    IconTrash,
    IconVideo,
    IconWand,
    IconZoomIn,
    IconPlay
} from '../canvas-icons';
import { InlineMarkdown } from '../ChatMarkdownRenderer';
import { NANO_BANANA_STYLES, synthesizeContextualNanoBananaPrompt } from '../nano-banana-service';
import { beautifyLocationSection } from '../services/location-beautify-service';
import { MediaGenerationClient } from '../media-generation-client';
import { useMediaJobPoller } from '../hooks/useMediaJobPolling';
import { IMAGE_MODEL_PRIORITY, mediaJobAttribution } from '../../../common/media-generation-protocol';
export { NANO_BANANA_STYLES };

export interface MarkdownDocumentPrimitiveProps {
    data: MarkdownDocumentData;
    activeArtifact?: CanvasArtifact;
    activeArtifactTitle?: string;
    onUpdate?: (updatedData: MarkdownDocumentData) => void;
    onPromptAction?: (promptText: string) => void;
    onMorphArtifact?: (artifact: CanvasArtifact) => void;
    onMorphToKanban?: (kanbanData: KanbanBoardData) => void;
    onMorphToNodeGraph?: (nodeGraphData: NodeGraphData) => void;
    onOpenInBrowser?: (url: string, title?: string) => void;
    onOpenWikilink?: (target: string, anchor?: string) => void;
    readOnly?: boolean;
    isStreaming?: boolean;
    streamingSectionId?: string;
    streamingBadgeText?: string;
    workspacePath?: string;
}

export const THEME_STYLE_PRESETS: Record<string, Record<string, { url: string; prompt: string }>> = {
    '1776-revolution': {
        'oil-painting': {
            url: 'https://images.unsplash.com/photo-1578301978693-85fa9c0320b9?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Masterpiece 18th-century classical oil painting of General George Washington crossing the ice-choked Delaware River on Christmas night 1776, dramatic stormy sky, Continental soldiers in wooden Durham boats, lantern illumination on icy waves, rich museum fine art texture.'
        },
        'cinematic-film': {
            url: 'https://images.unsplash.com/photo-1533158307587-828f0a76ef46?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Cinematic 35mm film still of 1776 colonial winter encampment, Continental Army soldiers gathered around glowing firelight, heavy snow falling, dramatic atmospheric haze, anamorphic lens character.'
        },
        'vintage-engraving': {
            url: 'https://images.unsplash.com/photo-1582555172866-f73bb12a2ab3?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Intricate antique copperplate engraving of the Second Continental Congress in Philadelphia July 1776, fine cross-hatching, sepia archival paper patina, high-resolution historical document illustration.'
        },
        'architectural': {
            url: 'https://images.unsplash.com/photo-1575881875475-31024b156660?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Architectural elevation and historical reconstruction blueprint of Independence Hall Assembly Room in Philadelphia 1776, Georgian colonial proportions, crisp drafting lines on aged parchment.'
        },
        'modern-editorial': {
            url: 'https://images.unsplash.com/photo-1461360370896-922624d12aa1?auto=format&fit=crop&w=1600&q=85',
            prompt: 'High-end fine art gallery editorial photography of antique parchment Declaration of Independence with natural museum window light and shallow depth of field.'
        }
    },
    'auth-zerotrust-security': {
        'architectural': {
            url: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Ultra-clean modern technical schematic of a zero-trust distributed mesh network, glowing cyan routing channels, biometric passkey hardware tokens, and low-latency edge proxy nodes on dark slate canvas.'
        },
        'neural-ai': {
            url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Cryptographic data matrix with glowing green and cyan terminal code, secure enclave memory isolation barriers, and asymmetric key rotation streams.'
        },
        'modern-editorial': {
            url: 'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Minimalist high-tech hardware security key on dark matte granite surface, soft volumetric studio lighting, Cupertino-grade macro product photography.'
        }
    },
    'ai-machine-learning': {
        'neural-ai': {
            url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1600&q=85',
            prompt: 'Multi-modal generative AI tensor network visualization, glowing transformer attention heads, vector embedding manifolds, and autonomous subagent routing nodes in vivid indigo and magenta.'
        },
        'cinematic-film': {
            url: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1600&q=85',
            prompt: 'High-density accelerated GPU computing cluster in dark datacenter with glowing fiber optic cables and soft holographic architectural overlays.'
        },
        'architectural': {
            url: 'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=1600&q=85',
            prompt: 'System architecture diagram of distributed autonomous reasoning engines and multi-agent task execution graphs, clean isometric vector blueprint.'
        }
    }
};

export function extractDomain(url?: string): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        const match = url.match(/^(?:https?:\/\/)?(?:www\.)?([^\/\?#]+)/i);
        return match ? match[1] : undefined;
    }
}

export function getTopicFallbackSvg(title: string, tag?: string, themeName?: string): string {
    const combined = `${title || ''} ${tag || ''} ${themeName || ''}`.toLowerCase();
    const is1776 = /1776|declaration|independence|philadelphia|washington|revolution|colonial/i.test(combined);
    const isAuth = /auth|security|oauth|passkey|jwt|zero[- ]trust/i.test(combined);
    const isAI = /ai|neural|model|llm|intelligence|transformer/i.test(combined);

    const bgGradStart = is1776 ? '#2a1a10' : isAuth ? '#081726' : isAI ? '#160826' : '#18181b';
    const bgGradEnd = is1776 ? '#140c06' : isAuth ? '#030810' : isAI ? '#090212' : '#09090b';
    const accentColor = is1776 ? '#f59e0b' : isAuth ? '#38bdf8' : isAI ? '#c084fc' : '#3b82f6';
    const accentSubtle = is1776 ? 'rgba(245, 158, 11, 0.16)' : isAuth ? 'rgba(56, 189, 248, 0.16)' : isAI ? 'rgba(192, 132, 252, 0.16)' : 'rgba(59, 130, 246, 0.16)';
    const icon = is1776 ? '🏛️' : isAuth ? '🛡️' : isAI ? '🧠' : '📐';
    const badgeText = tag || (is1776 ? 'Historical Landmark • 1776' : isAuth ? 'Security Specification' : isAI ? 'AI Architecture' : 'Editorial Spec');

    const cleanTitle = (title || 'Visual Context').replace(/[<>&"]/g, '');
    const cleanBadge = (badgeText || '').replace(/[<>&"]/g, '');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="100%" height="100%">
  <defs>
    <linearGradient id="bg-${cleanTitle.slice(0, 8)}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgGradStart}"/>
      <stop offset="100%" stop-color="${bgGradEnd}"/>
    </linearGradient>
    <radialGradient id="radial-${cleanTitle.slice(0, 8)}" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${accentColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="640" fill="url(#bg-${cleanTitle.slice(0, 8)})"/>
  <rect width="1200" height="640" fill="url(#radial-${cleanTitle.slice(0, 8)})"/>

  <!-- Decorative Frame -->
  <rect x="24" y="24" width="1152" height="592" rx="18" fill="none" stroke="${accentColor}" stroke-opacity="0.3" stroke-width="1.5" stroke-dasharray="8 6"/>

  <!-- Center Artwork Icon Badge -->
  <g transform="translate(600, 240)">
    <circle r="68" fill="${accentSubtle}" stroke="${accentColor}" stroke-opacity="0.5" stroke-width="2"/>
    <text font-size="52" text-anchor="middle" dominant-baseline="central">${icon}</text>
  </g>

  <!-- Title & Metadata -->
  <text x="600" y="375" fill="#f8fafc" font-size="28" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif">${cleanTitle}</text>
  
  <g transform="translate(600, 430)">
    <rect x="-150" y="-17" width="300" height="34" rx="17" fill="${accentSubtle}" stroke="${accentColor}" stroke-opacity="0.6" stroke-width="1.2"/>
    <text x="0" y="5" fill="${accentColor}" font-size="13" font-weight="600" letter-spacing="0.8" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">${cleanBadge}</text>
  </g>
</svg>`;

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function getLocationFallbackSvg(title: string, contextLabel?: string, metadata?: string, themeName?: string): string {
    const combined = `${title || ''} ${contextLabel || ''} ${themeName || ''}`.toLowerCase();
    const variant = /1776|declaration|independence|philadelphia|washington|revolution|colonial|historic/i.test(combined)
        ? 'historical'
        : /auth|security|oauth|passkey|zero[- ]trust|datacenter|edge/i.test(combined)
            ? 'infrastructure'
            : 'archive';
    const palette = variant === 'historical'
        ? { start: '#241b14', end: '#100d0a', line: '#b89662', text: '#f3eadc', quiet: '#c7b89f' }
        : variant === 'infrastructure'
            ? { start: '#101c26', end: '#080d12', line: '#6f91a8', text: '#edf4f7', quiet: '#a9bac4' }
            : { start: '#1b1d20', end: '#0d0e10', line: '#8f969d', text: '#f1f2f3', quiet: '#b2b6bb' };
    const escapeSvgText = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    const clampWords = (value: string, maxChars: number): string => {
        const normalized = value.replace(/\s+/g, ' ').trim();
        return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    };
    const titleWords = (title || 'Geographic landmark').replace(/\s+/g, ' ').trim().split(' ');
    const titleLines = titleWords.reduce<string[]>((lines, word) => {
        const activeLine = lines[lines.length - 1] || '';
        if (!activeLine || `${activeLine} ${word}`.length <= 42) {
            lines[lines.length - 1] = activeLine ? `${activeLine} ${word}` : word;
        } else {
            lines.push(word);
        }
        return lines;
    }, ['']).slice(0, 2);
    const titleWasClamped = titleWords.join(' ').length > titleLines.join(' ').length;
    const cleanTitleLines = titleLines.map((line, index) => {
        const constrainedLine = clampWords(line, index === 1 && titleWasClamped ? 38 : 42);
        const displayLine = index === 1 && titleWasClamped
            ? `${constrainedLine.replace(/…$/, '')}…`
            : constrainedLine;
        return escapeSvgText(displayLine);
    });
    const cleanContext = escapeSvgText(clampWords(contextLabel || 'Location context', 42).slice(0, 42));
    const cleanMetadata = escapeSvgText(clampWords(metadata || 'Archival geographic reference', 74).slice(0, 74));
    const titleTspans = cleanTitleLines.map((line, index) =>
        `<tspan x="600" dy="${index === 0 ? 0 : 42}">${line}</tspan>`
    ).join('');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" width="100%" height="100%">
  <defs>
    <linearGradient id="location-plate-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${palette.start}"/>
      <stop offset="100%" stop-color="${palette.end}"/>
    </linearGradient>
    <radialGradient id="location-plate-light" cx="50%" cy="42%" r="48%">
      <stop offset="0%" stop-color="${palette.line}" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="${palette.line}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#location-plate-bg)"/>
  <rect width="1200" height="675" fill="url(#location-plate-light)"/>
  <path d="M88 92h1024M88 583h1024" stroke="${palette.line}" stroke-opacity="0.28"/>
  <g transform="translate(600 260)" fill="none" stroke="${palette.line}" stroke-width="5">
    <path d="M0-67c-39 0-70 31-70 70 0 52 70 122 70 122S70 55 70 3c0-39-31-70-70-70Z"/>
    <path d="M-35 4h70M-27 4v39M-9 4v39M9 4v39M27 4v39M-39 45h78M-30-8 0-27 30-8Z" stroke-width="4"/>
  </g>
  <text x="600" y="440" fill="${palette.text}" font-size="34" font-weight="650" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif">${titleTspans}</text>
  <text x="600" y="555" fill="${palette.quiet}" font-size="16" text-anchor="middle" letter-spacing="0.4" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">${cleanMetadata}</text>
</svg>`;

    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Source: Google Maps Platform Code Assist
export function getGoogleStaticMapUrl(lat: number, lng: number, zoom: number = 14, layer: 'satellite' | 'roadmap' | 'hybrid' = 'hybrid', apiKey?: string): string {
    const key = apiKey || (typeof process !== 'undefined' ? process.env?.GOOGLE_MAPS_API_KEY : '') || '';
    const clampedZoom = Math.max(1, Math.min(20, Math.round(zoom)));
    const params = new URLSearchParams({
        center: `${lat},${lng}`,
        zoom: String(clampedZoom),
        size: '600x400',
        maptype: layer,
        format: 'png'
    });
    if (key) {
        params.set('key', key);
    }
    return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

export function getMercatorTileUrl(lat: number, lng: number, zoom: number, layer: 'satellite' | 'street' = 'satellite'): string {
    const key = (typeof process !== 'undefined' ? process.env?.GOOGLE_MAPS_API_KEY : '') || '';
    return getGoogleStaticMapUrl(lat, lng, zoom, layer === 'satellite' ? 'hybrid' : 'roadmap', key);
}

export const MarkdownDocumentPrimitive: React.FC<MarkdownDocumentPrimitiveProps> = ({
    data,
    activeArtifact,
    activeArtifactTitle,
    onUpdate,
    onPromptAction,
    onMorphArtifact,
    onMorphToKanban,
    onMorphToNodeGraph,
    onOpenInBrowser,
    onOpenWikilink,
    readOnly = false,
    isStreaming = false,
    streamingSectionId,
    streamingBadgeText,
    workspacePath
}) => {
    const mediaJobPoller = useMediaJobPoller();
    const sanitizeDoc = (raw: MarkdownDocumentData): MarkdownDocumentData => {
        const rawTitle = raw?.title || (raw as any)?.docTitle || (raw as any)?.name || (raw as any)?.summary;
        let t = rawTitle && rawTitle !== 'Markdown Document' && !/^untitled/i.test(rawTitle)
            ? rawTitle
            : (activeArtifactTitle || activeArtifact?.title || 'Project Specification & Strategic Notes');
        if (t === 'Markdown Document') {
            t = activeArtifactTitle || activeArtifact?.title || 'Project Specification & Strategic Notes';
        }

        const rawSubtitle = raw?.subtitle || (raw as any)?.docSubtitle || (raw as any)?.description;
        let subtitle = rawSubtitle;
        if (!subtitle || /^(click\s+to\s+add\s+document\s+subtitle|document\s+subtitle|subtitle)\.{0,3}$/i.test(subtitle.trim())) {
            if (/1776/i.test(t)) {
                subtitle = 'Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty';
            } else if (/auth|security|identity|zero[- ]trust/i.test(t)) {
                subtitle = 'Comprehensive Architecture, Protocol Specifications, Token Lifecycle, and Security Guardrails';
            } else {
                subtitle = `Strategic overview, architectural pillars, and execution roadmap for ${t}`;
            }
        }

        let rawSections: any[] = Array.isArray(raw?.sections) ? raw.sections : [];
        if (rawSections.length === 0 && t) {
            const synthesized = synthesizeComprehensiveDocument(t, t);
            rawSections = synthesized.sections || [];
            if (!subtitle || subtitle.includes('Strategic overview, architectural pillars')) {
                subtitle = synthesized.subtitle || subtitle;
            }
        }
        const sections: MarkdownSection[] = [];
        let headingCount = 0;

        rawSections.forEach((sec, idx) => {
            if (!sec || typeof sec !== 'object') return;
            const type = sec.type || 'paragraph';
            const id = sec.id || `sec-${type}-${idx + 1}`;

            if (type === 'heading') {
                const rawContent = sec.content ?? (sec as any).heading ?? (sec as any).title ?? (sec as any).text ?? (sec as any).name ?? (sec as any).headingText ?? (sec as any).value ?? '';
                let content = typeof rawContent === 'string' ? rawContent.trim() : '';
                const currentHeadingIdx = headingCount++;

                // Check if content is empty or literal placeholder
                if (!content || /^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3}|untitled(\s+section)?\.{0,3})$/i.test(content)) {
                    const num = currentHeadingIdx + 1;
                    const isHistory = /history|revolution|1776|civil war|empire|dynasty|battle|treaty|antiquity|medieval|renaissance/i.test(t);
                    const isScience = /astronomy|eclipse|physics|quantum|biology|chemistry|geology|relativity|space|cosmology|neuroscience/i.test(t);
                    const isTech = /auth|security|identity|software|system|architecture|api|database|cloud|algorithm|kubernetes|pipeline/i.test(t);
                    const isBusiness = /business|strategy|executive|market|finance|investment|roi|quarterly|startup/i.test(t);

                    if (isScience) {
                        const scienceHeadings = [
                            `1. Overview & Theoretical Foundations: ${t}`,
                            '2. Key Pillars & Empirical Principles',
                            '2.1 Structural Dynamics & Observational Methodology',
                            '2.2 Quantitative Analysis & Comparative Metrics',
                            '3. Experimental Verification & Observational Synthesis'
                        ];
                        content = scienceHeadings[currentHeadingIdx] || `${num}. Empirical Investigation & Findings`;
                    } else if (isHistory) {
                        const historyHeadings = [
                            `1. Historical Context & Genesis: ${t}`,
                            '2. Key Chronological Pillars & Turning Points',
                            '2.1 Catalysts, Ideology & Primary Antecedents',
                            '2.2 Critical Events, Battles & Structural Realignments',
                            '3. Enduring Significance & Modern Historiography'
                        ];
                        content = historyHeadings[currentHeadingIdx] || `${num}. Historical Analysis & Primary Sources`;
                    } else if (isTech) {
                        const techHeadings = [
                            `1. System Overview & Core Objectives: ${t}`,
                            '2. Architectural Pillars & Protocol Chronology',
                            '2.1 Modular Architecture, Invariants & Interface Contracts',
                            '2.2 Reliability Engineering & Automated Guardrails',
                            '3. Verification, Automated Testing & Operational Compliance'
                        ];
                        content = techHeadings[currentHeadingIdx] || `${num}. System Specification & Architecture`;
                    } else if (isBusiness) {
                        const businessHeadings = [
                            `1. Strategic Overview & Market Opportunity: ${t}`,
                            '2. Key Strategic Pillars & Value Proposition',
                            '2.1 Target Market Economics & Competitive Landscape',
                            '2.2 Operational Execution & Risk Mitigation',
                            '3. Actionable Milestones & Strategic Roadmap'
                        ];
                        content = businessHeadings[currentHeadingIdx] || `${num}. Strategic Analysis & Delivery`;
                    } else {
                        const genericHeadings = [
                            `1. Overview & Fundamental Principles: ${t}`,
                            '2. Core Dimensions & System Design',
                            '2.1 Invariant Structures & Primary Methodologies',
                            '2.2 Operational Reliability & Comparative Analysis',
                            '3. Actionable Milestones & Synthesis Checklist'
                        ];
                        content = genericHeadings[currentHeadingIdx] || `${num}. Implementation Details & Analysis`;
                    }
                }

                sections.push({
                    ...sec,
                    id,
                    type: 'heading',
                    level: sec.level === 1 || sec.level === 2 || sec.level === 3 ? sec.level : (currentHeadingIdx === 0 ? 1 : 2),
                    content
                });
            } else if (type === 'callout') {
                let calloutTitle = sec.calloutTitle ?? (sec as any).title ?? (sec as any).heading ?? (sec as any).name ?? '';
                let content = sec.content ?? (sec as any).text ?? (sec as any).body ?? '';

                // If callout title is placeholder or empty, inspect content for embedded markdown title
                if (!calloutTitle || /^(callout(\s+title)?\.{0,3}|note\.{0,3}|title\.{0,3})$/i.test(calloutTitle.trim())) {
                    const boldPrefixMatch = content.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i) || content.match(/^\[!([A-Z]+)\]\s*(.*)$/i);
                    if (boldPrefixMatch) {
                        calloutTitle = boldPrefixMatch[1].trim();
                        content = boldPrefixMatch[2].trim() || content;
                    } else if (/1776/i.test(t)) {
                        calloutTitle = 'Primary Source & Historical Context';
                    } else if (/auth|security/i.test(t)) {
                        calloutTitle = 'Security Guardrail & Cryptographic Protocol';
                    } else {
                        calloutTitle = 'Core Architecture Insight';
                    }
                }

                sections.push({
                    ...sec,
                    id,
                    type: 'callout',
                    calloutType: sec.calloutType || 'info',
                    calloutTitle,
                    content: content || calloutTitle
                });
            } else if (type === 'paragraph') {
                const rawContent = sec.content ?? (sec as any).text ?? (sec as any).body ?? '';
                sections.push({
                    ...sec,
                    id,
                    type: 'paragraph',
                    content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
                });
            } else {
                sections.push({ ...sec, id, type });
            }
        });

        return {
            title: t || 'Project Specification & Strategic Notes',
            subtitle,
            author: getActiveUserName(raw?.author) || DEFAULT_ACTIVE_USER_NAME,
            lastUpdated: raw?.lastUpdated || 'Just now',
            tags: Array.isArray(raw?.tags) ? raw.tags : ['Specification', 'Documentation'],
            sections
        };
    };

    const [doc, setDoc] = React.useState<MarkdownDocumentData>(() => sanitizeDoc(data));
    const [activeSectionId, setActiveSectionId] = React.useState<string | undefined>(undefined);
    const [editingSectionId, setEditingSectionId] = React.useState<string | undefined>(undefined);
    const [isEditingTitle, setIsEditingTitle] = React.useState<boolean>(false);
    const [isEditingSubtitle, setIsEditingSubtitle] = React.useState<boolean>(false);
    const [selectedText, setSelectedText] = React.useState<string>('');
    const [selectionCoords, setSelectionCoords] = React.useState<{ top: number; left: number } | undefined>(undefined);
    const [exportToast, setExportToast] = React.useState<string | undefined>(undefined);
    const [copiedCodeSectionId, setCopiedCodeSectionId] = React.useState<string | undefined>(undefined);
    const [isTocOpen, setIsTocOpen] = React.useState<boolean>(false);

    const headingSections = React.useMemo(() => {
        return (doc.sections || []).filter(s => s.type === 'heading' && s.content && s.content.trim().length > 0);
    }, [doc.sections]);

    const handleCopyCode = (sectionId: string, codeText: string, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        try {
            navigator.clipboard.writeText(codeText);
        } catch (err) {
            // fallback
        }
        setCopiedCodeSectionId(sectionId);
        setTimeout(() => setCopiedCodeSectionId(undefined), 2000);
    };

    // Active inserter popover tracking
    const [activeInserterIndex, setActiveInserterIndex] = React.useState<number | undefined>(undefined);

    // 4D Interactive Simulation & Editorial Nano Banana States
    const [lightboxImage, setLightboxImage] = React.useState<{
        url: string;
        title?: string;
        caption?: string;
        attribution?: string;
        dateTag?: string;
        prompt?: string;
        stylePreset?: string;
    } | null>(null);
    const [regeneratingImages, setRegeneratingImages] = React.useState<Record<string, boolean>>({});
    const [openStyleMenuSectionId, setOpenStyleMenuSectionId] = React.useState<string | null>(null);
    const [copiedPromptSectionId, setCopiedPromptSectionId] = React.useState<string | null>(null);

    const handleCopyPrompt = (sectionId: string, promptText: string, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        try {
            navigator.clipboard.writeText(promptText);
        } catch (err) {
            // Fallback for clipboard if not available in some contexts
        }
        setCopiedPromptSectionId(sectionId);
        setTimeout(() => setCopiedPromptSectionId(null), 2000);
    };

    const [selectedDiagramNodes, setSelectedDiagramNodes] = React.useState<Record<string, string | undefined>>({});

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setLightboxImage(null);
                setOpenStyleMenuSectionId(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    React.useEffect(() => {
        setDoc(sanitizeDoc(data));
    }, [data]);

    const updateAndNotify = (newDoc: MarkdownDocumentData) => {
        setDoc(newDoc);
        if (onUpdate) {
            onUpdate(newDoc);
        }
    };

    const handleTextSelection = () => {
        if (editingSectionId) return;
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 3) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            setSelectedText(selection.toString().trim());
            setSelectionCoords({
                top: rect.top - 46,
                left: rect.left + rect.width / 2
            });
        } else {
            setSelectedText('');
            setSelectionCoords(undefined);
        }
    };

    const handleSelectionAction = (actionPrompt: string) => {
        if (!onPromptAction || !selectedText) { return; }
        onPromptAction(`${actionPrompt} for the selected excerpt: "${selectedText.slice(0, 180)}" in document "${doc.title}".`);
        setSelectedText('');
        setSelectionCoords(undefined);
        window.getSelection()?.removeAllRanges();
    };

    const handleWikilinkNavigation = (target: string, anchor?: string) => {
        if (onOpenWikilink) {
            onOpenWikilink(target, anchor);
            return;
        }
        const lookup = (anchor || target).trim().toLowerCase();
        const targetSection = doc.sections.find(s =>
            (s.type === 'heading' && s.content?.trim().toLowerCase() === lookup) ||
            (s.calloutTitle && s.calloutTitle.trim().toLowerCase() === lookup)
        );
        if (targetSection) {
            const el = document.getElementById(`doc-sec-${targetSection.id}`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
        }
        if (onOpenInBrowser) {
            onOpenInBrowser(`#wikilink:${encodeURIComponent(target)}`, target);
        }
    };

    const handleAutoLinkNotes = () => {
        const concepts = new Set<string>();
        if (doc.title && doc.title.length > 3) concepts.add(doc.title);
        (doc.sections || []).forEach(s => {
            if (s.type === 'heading' && s.content && s.content.trim().length > 3) {
                const clean = s.content.replace(/^[\d.]+\s*/, '').trim();
                if (clean.length > 3) concepts.add(clean);
            }
            if (s.calloutTitle && s.calloutTitle.trim().length > 3) {
                concepts.add(s.calloutTitle.trim());
            }
        });
        if (activeArtifactTitle && activeArtifactTitle.length > 3) {
            concepts.add(activeArtifactTitle);
        }

        const sortedConcepts = Array.from(concepts).sort((a, b) => b.length - a.length);
        if (sortedConcepts.length === 0) {
            setExportToast('No concepts found to auto-link.');
            setTimeout(() => setExportToast(undefined), 3000);
            return;
        }

        let totalLinksCreated = 0;
        const newSections = (doc.sections || []).map(sec => {
            if (sec.type !== 'paragraph' && sec.type !== 'callout' && sec.type !== 'quote') {
                return sec;
            }
            let text = sec.content || '';
            for (const concept of sortedConcepts) {
                const escaped = concept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b(${escaped})\\b`, 'gi');
                text = text.replace(regex, (match, _p1, offset, fullStr) => {
                    const before = fullStr.slice(0, offset);
                    const openWikis = (before.match(/\[\[/g) || []).length;
                    const closeWikis = (before.match(/\]\]/g) || []).length;
                    if (openWikis > closeWikis) return match;
                    const openBrackets = (before.match(/\[/g) || []).length;
                    const closeBrackets = (before.match(/\]/g) || []).length;
                    if (openBrackets > closeBrackets) return match;
                    totalLinksCreated++;
                    return `[[${match}]]`;
                });
            }
            return text !== sec.content ? { ...sec, content: text } : sec;
        });

        if (totalLinksCreated > 0) {
            updateAndNotify({ ...doc, sections: newSections });
            setExportToast(`✨ Auto-linked ${totalLinksCreated} concept(s) across document!`);
        } else {
            setExportToast('All concepts are already linked with [[wikilinks]].');
        }
        setTimeout(() => setExportToast(undefined), 3500);
    };

    const attachDiffToSelectedSection = (origText: string, proposedText: string, actionLabel: string) => {
        const targetSec = doc.sections.find(s => s.content && s.content.includes(origText));
        if (targetSec) {
            const updatedSec: MarkdownSection = {
                ...targetSec,
                diffPreview: {
                    originalText: origText,
                    proposedText: proposedText,
                    actionLabel
                }
            };
            updateAndNotify({
                ...doc,
                sections: doc.sections.map(s => s.id === targetSec.id ? updatedSec : s)
            });
            setExportToast(`✨ Proposed diff: ${actionLabel}. Review & Accept or Reject.`);
        } else {
            const newSection: MarkdownSection = {
                id: `sec-${Date.now()}`,
                type: 'paragraph',
                content: origText,
                diffPreview: {
                    originalText: origText,
                    proposedText: proposedText,
                    actionLabel
                }
            };
            updateAndNotify({ ...doc, sections: [...doc.sections, newSection] });
            setExportToast(`✨ Proposed diff: ${actionLabel}. Review & Accept or Reject.`);
        }
        setTimeout(() => setExportToast(undefined), 3500);
        setSelectedText('');
        setSelectionCoords(undefined);
        window.getSelection()?.removeAllRanges();
    };

    const handleAcceptDiff = (sectionId: string) => {
        const sec = doc.sections.find(s => s.id === sectionId);
        if (!sec || !sec.diffPreview) return;
        const { originalText, proposedText } = sec.diffPreview;
        const newContent = sec.content ? sec.content.replace(originalText, proposedText) : proposedText;
        const updatedSec: MarkdownSection = {
            ...sec,
            content: newContent,
            diffPreview: undefined
        };
        updateAndNotify({
            ...doc,
            sections: doc.sections.map(s => s.id === sectionId ? updatedSec : s)
        });
        setExportToast('✓ Accepted AI transformation changes.');
        setTimeout(() => setExportToast(undefined), 2500);
    };

    const handleRejectDiff = (sectionId: string) => {
        updateAndNotify({
            ...doc,
            sections: doc.sections.map(s => s.id === sectionId ? { ...s, diffPreview: undefined } : s)
        });
        setExportToast('✕ Discarded proposed transformation.');
        setTimeout(() => setExportToast(undefined), 2000);
    };

    const handleSelectionToTable = () => {
        if (!selectedText) return;
        const lines = selectedText.split('\n').map(l => l.trim()).filter(Boolean);
        let tableMarkdown = '';
        if (lines.length > 0) {
            const delimiter = lines[0].includes('|') ? '|' : (lines[0].includes(':') ? ':' : (lines[0].includes(',') ? ',' : '\t'));
            const parsedRows = lines.map(line => {
                if (delimiter === ':') {
                    const parts = line.split(':');
                    return [parts[0].trim(), parts.slice(1).join(':').trim()];
                } else if (delimiter === '|') {
                    return line.split('|').map(c => c.trim()).filter(Boolean);
                } else {
                    return line.split(delimiter).map(c => c.trim());
                }
            });

            const colCount = Math.max(...parsedRows.map(r => r.length), 2);
            const headers = parsedRows[0].length === colCount && parsedRows.length > 1
                ? parsedRows[0]
                : Array.from({ length: colCount }, (_, idx) => `Column ${idx + 1}`);
            const dataRows = parsedRows[0].length === colCount && parsedRows.length > 1
                ? parsedRows.slice(1)
                : parsedRows;

            tableMarkdown = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n` +
                dataRows.map(r => `| ${Array.from({ length: colCount }, (_, i) => r[i] || '').join(' | ')} |`).join('\n');
        }

        attachDiffToSelectedSection(selectedText, tableMarkdown, 'Format as Markdown Table');
    };

    const handleSelectionToChecklist = () => {
        if (!selectedText) return;
        const lines = selectedText.split('\n').map(l => l.trim()).filter(Boolean);
        const checklistMarkdown = lines.map(l => {
            const clean = l.replace(/^[-*•\d.]+\s*/, '');
            return `- [ ] ${clean}`;
        }).join('\n');

        attachDiffToSelectedSection(selectedText, checklistMarkdown, 'Convert to Actionable Checklist');
    };

    const handleSelectionToAiCallout = () => {
        if (!selectedText) return;
        const newSection: MarkdownSection = {
            id: `sec-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            type: 'callout',
            calloutType: 'ai',
            calloutTitle: 'AI Provenance & Synthesis',
            content: selectedText,
            aiProvenance: {
                model: 'Gemini 2.5 Pro',
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                prompt: 'Extracted key insight for document knowledge graph',
                isCollapsed: false,
                originalContent: selectedText
            }
        };

        const insertIdx = activeSectionId ? doc.sections.findIndex(s => s.id === activeSectionId) + 1 : doc.sections.length;
        const newSections = [...doc.sections];
        newSections.splice(Math.max(0, insertIdx), 0, newSection);
        updateAndNotify({ ...doc, sections: newSections });
        setExportToast('✨ Wrapped selected excerpt into Collapsible AI Callout!');
        setTimeout(() => setExportToast(undefined), 3000);
        setSelectedText('');
        setSelectionCoords(undefined);
        window.getSelection()?.removeAllRanges();
    };

    const handlePromoteAiCallout = (sectionId: string) => {
        const sec = doc.sections.find(s => s.id === sectionId);
        if (!sec) return;
        const promotedSection: MarkdownSection = {
            ...sec,
            type: 'paragraph',
            calloutType: undefined,
            calloutTitle: undefined,
            aiProvenance: undefined
        };
        updateAndNotify({
            ...doc,
            sections: doc.sections.map(s => s.id === sectionId ? promotedSection : s)
        });
        setExportToast('✨ Promoted AI Callout to document body.');
        setTimeout(() => setExportToast(undefined), 2500);
    };

    const handleToggleAiCollapse = (sectionId: string) => {
        updateAndNotify({
            ...doc,
            sections: doc.sections.map(s => {
                if (s.id === sectionId && s.aiProvenance) {
                    return {
                        ...s,
                        aiProvenance: {
                            ...s.aiProvenance,
                            isCollapsed: !s.aiProvenance.isCollapsed
                        }
                    };
                }
                return s;
            })
        });
    };

    const handleToggleChecklist = (sectionId: string, itemId: string) => {
        const sections = doc.sections || [];
        const newSections = sections.map(section => {
            if (section.id === sectionId && section.checklistItems) {
                return {
                    ...section,
                    checklistItems: section.checklistItems.map(item =>
                        item.id === itemId ? { ...item, done: !item.done } : item
                    )
                };
            }
            return section;
        });

        const newDoc: MarkdownDocumentData = { ...doc, sections: newSections };
        updateAndNotify(newDoc);
    };

    const handlePromptForSection = (section: MarkdownSection, action: string) => {
        if (!onPromptAction) { return; }
        let targetText = section.content || section.calloutTitle || section.locationName || section.videoTitle || section.diagramTitle;
        if (!targetText && section.type === 'table') {
            targetText = section.tableHeaders ? section.tableHeaders.join(', ') : 'Table matrix';
        } else if (!targetText && section.type === 'checklist') {
            targetText = section.checklistItems ? section.checklistItems.map(i => i.text).join('; ') : 'Checklist tasks';
        }
        const prompt = `${action} for section "${(targetText || 'selected content').slice(0, 160)}" in document "${doc.title}".`;
        onPromptAction(prompt);
    };

    // In-place document section mutation helpers
    const handleUpdateSection = (sectionId: string, updates: Partial<MarkdownSection>) => {
        const newSections = (doc.sections || []).map(sec =>
            sec.id === sectionId ? { ...sec, ...updates } : sec
        );
        updateAndNotify({ ...doc, sections: newSections });
    };

    const handleDeleteSection = (sectionId: string, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        const newSections = (doc.sections || []).filter(sec => sec.id !== sectionId);
        if (editingSectionId === sectionId) {
            setEditingSectionId(undefined);
        }
        updateAndNotify({ ...doc, sections: newSections });
    };

    const handleMoveSection = (index: number, direction: 'up' | 'down', e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        const sections = [...(doc.sections || [])];
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= sections.length) return;
        const [moved] = sections.splice(index, 1);
        sections.splice(targetIndex, 0, moved);
        updateAndNotify({ ...doc, sections });
    };

    const handleNanoBananaRegenerate = async (section: MarkdownSection, selectedStyleId?: string) => {
        setRegeneratingImages(prev => ({ ...prev, [section.id]: true }));
        setOpenStyleMenuSectionId(null);

        const styleKey = selectedStyleId || (
            section.stylePreset?.toLowerCase().includes('oil') ? 'oil-painting'
            : section.stylePreset?.toLowerCase().includes('engraving') ? 'vintage-engraving'
            : section.stylePreset?.toLowerCase().includes('blueprint') || section.stylePreset?.toLowerCase().includes('schematic') || section.stylePreset?.toLowerCase().includes('architectural') ? 'architectural'
            : section.stylePreset?.toLowerCase().includes('neural') ? 'neural-ai'
            : section.stylePreset?.toLowerCase().includes('cupertino') || section.stylePreset?.toLowerCase().includes('studio') ? 'modern-editorial'
            : section.stylePreset?.toLowerCase().includes('chiaroscuro') ? 'chiaroscuro'
            : section.stylePreset?.toLowerCase().includes('watercolor') ? 'watercolor'
            : 'cinematic-film'
        );

        if (section.type === 'location-image') {
            const restyled = beautifyLocationSection(section, {
                styleId: styleKey,
                docTitle: doc.title
            });

            setTimeout(() => {
                handleUpdateSection(section.id, {
                    imageUrl: restyled.imageUrl,
                    thumbnailUrl: restyled.thumbnailUrl,
                    stylePreset: restyled.stylePreset,
                    visualPrompt: restyled.visualPrompt,
                    attribution: restyled.attribution,
                    imageTitle: restyled.imageTitle || section.imageTitle,
                    caption: restyled.caption || section.caption,
                    dateTag: restyled.dateTag || section.dateTag
                });
                setRegeneratingImages(prev => ({ ...prev, [section.id]: false }));
            }, 500);
            return;
        }

        // Find surrounding context (nearby headings, paragraphs, callouts in doc.sections)
        const secIndex = (doc.sections || []).findIndex(s => s.id === section.id);
        const adjacentSections = (doc.sections || []).slice(Math.max(0, secIndex - 2), secIndex + 3);
        const adjacentText = adjacentSections.map(s => s.content || s.caption || s.calloutTitle || s.locationName || s.videoTitle || '').join(' ');

        const synth = synthesizeContextualNanoBananaPrompt({
            docTitle: doc.title,
            docSubtitle: doc.subtitle,
            sectionTitle: section.imageTitle || section.videoTitle || section.locationName,
            sectionContent: section.caption || section.description || section.content,
            adjacentText,
            styleId: styleKey
        });

        const activePrompt = section.prompt || section.visualPrompt || synth.prompt;
        const isVideo = section.type === 'video';

        try {
            const client = MediaGenerationClient.getInstance();
            const wsPath = workspacePath || (typeof window !== 'undefined' ? (window as any).__scratchbox_active_workspace_path : undefined) || '';
            const idempotencyKey = `doc-media-${section.id}-${Date.now()}`;

            const job = await client.start({
                kind: isVideo ? 'video' : 'image',
                prompt: activePrompt,
                workspaceRoot: wsPath,
                idempotencyKey,
                aspectRatio: '16:9',
                modelPriority: isVideo
                    ? ['google/omni-1.1', 'gemini-omni-flash-video', 'veo-3.1-generate-preview']
                    : IMAGE_MODEL_PRIORITY
            });

            if (job) {
                // Fallback to the contextual synthesized asset on failure / quota / transport errors.
                const applyCuratedFallback = () => {
                    handleUpdateSection(section.id, {
                        imageUrl: synth.curatedImageUrl,
                        thumbnailUrl: synth.curatedImageUrl,
                        stylePreset: synth.styleLabel,
                        visualPrompt: activePrompt,
                        attribution: synth.attribution,
                        imageTitle: section.imageTitle || section.videoTitle || synth.imageTitle,
                        caption: section.caption || synth.caption
                    });
                    setRegeneratingImages(prev => ({ ...prev, [section.id]: false }));
                };
                // Polling is owned by useMediaJobPoller: aborted + interval cleared on unmount.
                mediaJobPoller.startPolling({
                    jobId: job.id,
                    workspaceRoot: wsPath,
                    intervalMs: 2000,
                    onComplete: (done) => {
                        const resultUrl = client.contentUrl(job.id, wsPath);
                        handleUpdateSection(section.id, {
                            imageUrl: resultUrl,
                            thumbnailUrl: resultUrl,
                            videoUrl: isVideo ? resultUrl : undefined,
                            stylePreset: synth.styleLabel,
                            visualPrompt: activePrompt,
                            // The model that actually answered, and why when it is not the requested one.
                            attribution: mediaJobAttribution(done),
                            imageTitle: section.imageTitle || section.videoTitle || synth.imageTitle,
                            caption: section.caption || synth.caption
                        });
                        setRegeneratingImages(prev => ({ ...prev, [section.id]: false }));
                    },
                    onError: applyCuratedFallback
                });
                return;
            }
        } catch (genErr) {
            console.warn('[MarkdownDocumentPrimitive] Live media generation fallback to contextual asset:', genErr);
        }

        setTimeout(() => {
            handleUpdateSection(section.id, {
                imageUrl: synth.curatedImageUrl,
                thumbnailUrl: synth.curatedImageUrl,
                stylePreset: synth.styleLabel,
                visualPrompt: activePrompt,
                attribution: synth.attribution,
                imageTitle: section.imageTitle || section.videoTitle || synth.imageTitle,
                caption: section.caption || synth.caption
            });
            setRegeneratingImages(prev => ({ ...prev, [section.id]: false }));
        }, 500);
    };

    const handleSelectDiagramNode = (sectionId: string, nodeId: string, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setSelectedDiagramNodes(prev => ({
            ...prev,
            [sectionId]: prev[sectionId] === nodeId ? undefined : nodeId
        }));
    };

    const handleAddSection = (index: number, type: MarkdownSection['type']) => {
        const id = `sec-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const theme = detectDocumentTheme(doc.title, doc.sections?.map(s => s.content || '').join(' '));
        let newSec: MarkdownSection;

        switch (type) {
            case 'heading': {
                let defaultHeading = '2. Architecture & Strategic Analysis';
                if (theme === '1776-revolution') {
                    defaultHeading = 'Historical Turning Point & Strategic Significance';
                } else if (theme === 'auth-zerotrust-security') {
                    defaultHeading = 'Cryptographic Verification & Token Protocol';
                } else if (theme === 'ai-machine-learning') {
                    defaultHeading = 'Neural Attention & Multi-Modal Processing';
                }
                newSec = { id, type: 'heading', level: 2, content: defaultHeading };
                break;
            }
            case 'paragraph': {
                let defaultParagraph = 'Add your detailed thoughts, specifications, or findings here...';
                if (theme === '1776-revolution') {
                    defaultParagraph = 'The enduring impact of these foundational events continues to shape modern constitutional governance and civil liberties.';
                } else if (theme === 'auth-zerotrust-security') {
                    defaultParagraph = 'The Zero-Trust verification framework enforces sub-millisecond cryptographic attestation on every inbound API transaction.';
                }
                newSec = { id, type: 'paragraph', content: defaultParagraph };
                break;
            }
            case 'location-image':
                newSec = generateMotivatedLocationSection(theme, undefined, doc.title);
                newSec.id = id;
                break;
            case 'editorial-image':
            case 'image':
                newSec = generateMotivatedEditorialImageSection(theme, undefined, doc.title);
                newSec.id = id;
                break;
            case 'video':
                newSec = generateMotivatedVideoSection(theme, undefined, doc.title);
                newSec.id = id;
                break;
            case 'svg-diagram':
                newSec = generateMotivatedSvgSection(theme, undefined, doc.title);
                newSec.id = id;
                break;
            case 'citation':
                newSec = generateMotivatedCitationSection(theme, undefined);
                newSec.id = id;
                break;
            case 'callout':
                newSec = {
                    id,
                    type: 'callout',
                    calloutType: 'tip',
                    calloutTitle: theme === '1776-revolution' ? 'Historical Context & Primary Insight' : 'Core Architecture Guardrail',
                    content: theme === '1776-revolution'
                        ? 'Enlightenment political theory provided the essential moral and philosophical justification for colonial independence.'
                        : 'All edge communication channels enforce mTLS 1.3 encryption with strict capability-based authorization policies.'
                };
                break;
            case 'table':
                newSec = {
                    id,
                    type: 'table',
                    tableHeaders: theme === '1776-revolution'
                        ? ['Event / Milestone', 'Date', 'Key Revolutionary Figures', 'Strategic Outcome']
                        : ['Capability / Component', 'Specification', 'Target Latency', 'Status'],
                    tableRows: theme === '1776-revolution'
                        ? [
                            ['Common Sense Published', 'Jan 1776', 'Thomas Paine', 'Galvanized widespread public mandate for separation'],
                            ['Declaration Ratified', 'July 4, 1776', 'Jefferson, Adams, Franklin', 'Inaugurated sovereign democratic nationhood'],
                            ['Delaware Crossing & Trenton', 'Dec 25–26, 1776', 'George Washington, Col. Glover', 'Surprise tactical victory revitalizing army morale']
                        ]
                        : [
                            ['Real-Time Canvas', 'Built-in Visual Stage', '< 16ms (60fps)', 'Active'],
                            ['Multi-Modal Media Blocks', 'Location, Video, SVG, Citations', '< 30ms TTFT', 'Supported']
                        ]
                };
                break;
            case 'checklist':
                newSec = {
                    id,
                    type: 'checklist',
                    checklistItems: theme === '1776-revolution'
                        ? [
                            { id: `chk-${Date.now()}-1`, text: 'Unanimous adoption of the Declaration of Independence by Continental Congress', done: true },
                            { id: `chk-${Date.now()}-2`, text: 'Establishment of diplomatic alliances and international recognitions', done: true },
                            { id: `chk-${Date.now()}-3`, text: 'Drafting of individual state constitutional charters and civic protections', done: false }
                        ]
                        : [
                            { id: `chk-${Date.now()}-1`, text: 'Initial design review & HIG alignment', done: true },
                            { id: `chk-${Date.now()}-2`, text: 'Implement visual multi-modal media blocks', done: true },
                            { id: `chk-${Date.now()}-3`, text: 'Verify CSV data drag-and-drop & charts', done: false }
                        ]
                };
                break;
            case 'code':
                newSec = {
                    id,
                    type: 'code',
                    content: theme === 'auth-zerotrust-security'
                        ? '// Asymmetric Ed25519 JWT validation\nexport async function verifyToken(jwt: string, jwks: any): Promise<any> {\n  return jwtVerify(jwt, jwks.getKey(), { algorithms: ["EdDSA"] });\n}'
                        : '// Live code snippet\nfunction calculateVelocity(sprintPoints: number[]) {\n  return sprintPoints.reduce((a, b) => a + b, 0) / sprintPoints.length;\n}'
                };
                break;
            default:
                newSec = { id, type: 'paragraph', content: 'New content block' };
        }

        const sections = [...(doc.sections || [])];
        sections.splice(index, 0, newSec);
        setActiveInserterIndex(undefined);
        setEditingSectionId(id);
        updateAndNotify({ ...doc, sections });
    };

    // Table modification helpers
    const handleUpdateTableCell = (sectionId: string, rowIdx: number, colIdx: number, val: string, isHeader: boolean = false) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec) return;

        if (isHeader) {
            const headers = [...(sec.tableHeaders || [])];
            headers[colIdx] = val;
            handleUpdateSection(sectionId, { tableHeaders: headers });
        } else {
            const rows = (sec.tableRows || []).map((r, rI) => {
                if (rI !== rowIdx) return r;
                const newRow = [...r];
                newRow[colIdx] = val;
                return newRow;
            });
            handleUpdateSection(sectionId, { tableRows: rows });
        }
    };

    const handleAddTableRow = (sectionId: string) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec) return;
        const colCount = sec.tableHeaders?.length || (sec.tableRows?.[0]?.length || 3);
        const newRow = Array.from({ length: colCount }, (_, i) => `Item ${i + 1}`);
        const rows = [...(sec.tableRows || []), newRow];
        handleUpdateSection(sectionId, { tableRows: rows });
    };

    const handleAddTableColumn = (sectionId: string) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec) return;
        const headers = [...(sec.tableHeaders || []), `New Column ${(sec.tableHeaders?.length || 0) + 1}`];
        const rows = (sec.tableRows || []).map(r => [...r, '-']);
        handleUpdateSection(sectionId, { tableHeaders: headers, tableRows: rows });
    };

    const handleDeleteTableRow = (sectionId: string, rowIdx: number) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec || !sec.tableRows) return;
        const rows = sec.tableRows.filter((_, idx) => idx !== rowIdx);
        handleUpdateSection(sectionId, { tableRows: rows });
    };

    // Checklist item modification helpers
    const handleUpdateChecklistText = (sectionId: string, itemId: string, text: string) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec || !sec.checklistItems) return;
        const items = sec.checklistItems.map(item => item.id === itemId ? { ...item, text } : item);
        handleUpdateSection(sectionId, { checklistItems: items });
    };

    const handleAddChecklistItem = (sectionId: string) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec) return;
        const newItem = { id: `chk-${Date.now()}`, text: 'New action item', done: false };
        const items = [...(sec.checklistItems || []), newItem];
        handleUpdateSection(sectionId, { checklistItems: items });
    };

    const handleDeleteChecklistItem = (sectionId: string, itemId: string) => {
        const sec = doc.sections?.find(s => s.id === sectionId);
        if (!sec || !sec.checklistItems) return;
        const items = sec.checklistItems.filter(item => item.id !== itemId);
        handleUpdateSection(sectionId, { checklistItems: items });
    };

    const handleExportMarkdown = () => {
        let md = `# ${doc.title}\n`;
        if (doc.subtitle) md += `_${doc.subtitle}_\n\n`;
        if (doc.author || doc.lastUpdated) {
            md += `> ${doc.author ? `**Author**: ${doc.author}  ` : ''}${doc.lastUpdated ? `**Updated**: ${doc.lastUpdated}` : ''}\n\n`;
        }
        if (doc.tags && doc.tags.length > 0) {
            md += `**Tags**: ${doc.tags.map(t => `#${t}`).join(' ')}\n\n`;
        }

        (doc.sections || []).forEach(sec => {
            if (sec.type === 'heading') {
                const prefix = '#'.repeat(Math.max(1, Math.min(6, (sec.level || 2) + 1)));
                md += `${prefix} ${sec.content}\n\n`;
            } else if (sec.type === 'paragraph') {
                md += `${sec.content}\n\n`;
            } else if (sec.type === 'location-image') {
                md += `> 📍 **Location**: ${sec.locationName || 'Location'}${sec.coordinates ? ` (${sec.coordinates.lat}° N, ${sec.coordinates.lng}° W)` : ''}\n`;
                if (sec.imageUrl) md += `> ![](${sec.imageUrl})\n`;
                if (sec.caption) md += `> _${sec.caption}_\n\n`;
            } else if (sec.type === 'editorial-image' || sec.type === 'image') {
                md += `> 🖼️ **${sec.imageTitle || 'Editorial Image'}**\n`;
                if (sec.imageUrl) md += `> ![](${sec.imageUrl})\n`;
                if (sec.caption) md += `> _${sec.caption}_\n`;
                if (sec.attribution) md += `> _Source: ${sec.attribution}_\n\n`;
            } else if (sec.type === 'video') {
                md += `> 🎬 **${sec.imageTitle || sec.videoTitle || 'Visual Reconstruction'}**\n`;
                if (sec.imageUrl || sec.thumbnailUrl) md += `> ![](${sec.imageUrl || sec.thumbnailUrl})\n`;
                if (sec.caption || sec.description) md += `> _${sec.caption || sec.description}_\n`;
                if (sec.attribution) md += `> _Source: ${sec.attribution}_\n\n`;
            } else if (sec.type === 'svg-diagram') {
                md += `> 📊 **Diagram**: ${sec.diagramTitle || 'Diagram'} (${sec.diagramType || 'diagram'})\n\n`;
            } else if (sec.type === 'citation') {
                md += `### Primary Sources & References\n\n`;
                (sec.citationItems || []).forEach((c, idx) => {
                    md += `${idx + 1}. [**${c.sourceTitle}**](${c.url || '#'}) — _${c.author || 'Archival Reference'}_ (${c.year || ''})${c.verified ? ' `[Verified]`' : ''}\n`;
                    if (c.quoteSnippet) {
                        md += `   > "${c.quoteSnippet}"\n`;
                    }
                });
                md += '\n';
            } else if (sec.type === 'callout') {
                const cType = sec.calloutType || 'info';
                const collapseMark = sec.aiProvenance?.isCollapsed ? '-' : '+';
                const meta = sec.aiProvenance?.model ? ` [${sec.aiProvenance.model}]` : '';
                md += `> [!${cType}]${collapseMark} ${sec.calloutTitle || (cType === 'ai' ? 'AI Provenance' : 'Note')}${meta}\n> ${sec.content}\n\n`;
            } else if (sec.type === 'table') {
                const headers = sec.tableHeaders || [];
                const rows = sec.tableRows || [];
                if (headers.length > 0) {
                    md += `| ${headers.join(' | ')} |\n`;
                    md += `| ${headers.map(() => '---').join(' | ')} |\n`;
                    rows.forEach(r => {
                        md += `| ${r.join(' | ')} |\n`;
                    });
                    md += '\n';
                }
            } else if (sec.type === 'checklist') {
                (sec.checklistItems || []).forEach(item => {
                    md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
                });
                md += '\n';
            } else if (sec.type === 'code') {
                md += `\`\`\`${sec.codeLanguage || ''}\n${sec.content}\n\`\`\`\n\n`;
            }
        });

        if (typeof document !== 'undefined') {
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `${(doc.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }

        setExportToast('Markdown exported successfully');
        setTimeout(() => setExportToast(undefined), 3000);
    };

    const handleMorphDocumentToKanban = () => {
        if (!onMorphToKanban) return;
        const allChecklistItems: Array<{ id: string; text: string; done: boolean }> = [];
        const headings: string[] = [];

        (doc.sections || []).forEach(sec => {
            if (sec.type === 'checklist' && Array.isArray(sec.checklistItems)) {
                allChecklistItems.push(...sec.checklistItems);
            } else if (sec.type === 'heading' && sec.content) {
                headings.push(sec.content);
            }
        });

        const todoCards: KanbanCard[] = [];
        const inProgressCards: KanbanCard[] = [];
        const doneCards: KanbanCard[] = [];

        if (allChecklistItems.length > 0) {
            allChecklistItems.forEach((item, idx) => {
                const card: KanbanCard = {
                    id: `card-${idx + 1}`,
                    title: item.text,
                    description: `Extracted from document checklist`,
                    tag: 'Task'
                };
                if (item.done) {
                    doneCards.push(card);
                } else if (idx % 2 === 0) {
                    todoCards.push(card);
                } else {
                    inProgressCards.push(card);
                }
            });
        } else {
            headings.slice(0, 6).forEach((h, idx) => {
                const card: KanbanCard = {
                    id: `card-h-${idx + 1}`,
                    title: h,
                    description: `Milestone extracted from ${doc.title}`,
                    tag: 'Milestone'
                };
                if (idx === 0) doneCards.push(card);
                else if (idx === 1 || idx === 2) inProgressCards.push(card);
                else todoCards.push(card);
            });
        }

        const kanbanData: KanbanBoardData = {
            title: `${doc.title} — Sprint Board`,
            subtitle: `Interactive workflow extracted from "${doc.title}"`,
            columns: [
                { id: 'col-todo', title: 'To Do', color: 'blue', cards: todoCards },
                { id: 'col-inprogress', title: 'In Progress', color: 'amber', cards: inProgressCards },
                { id: 'col-done', title: 'Completed', color: 'emerald', cards: doneCards }
            ]
        };

        onMorphToKanban(kanbanData);
    };

    const handleMorphDocumentToNodeGraph = () => {
        if (!onMorphToNodeGraph) return;
        const headings: string[] = [];
        (doc.sections || []).forEach(sec => {
            if (sec.type === 'heading' && sec.content) {
                headings.push(sec.content);
            }
        });

        const nodeLabels = headings.length >= 2 ? headings.slice(0, 5) : [
            '1. Requirements & Spec',
            '2. System Architecture',
            '3. Core Engine Pipeline',
            '4. Verification Suite',
            '5. Production Release'
        ];

        const nodes: GraphNode[] = nodeLabels.map((lbl, idx) => ({
            id: `node-${idx + 1}`,
            label: lbl,
            category: idx === 0 ? 'input' : (idx === nodeLabels.length - 1 ? 'output' : 'process'),
            x: 100 + idx * 220,
            y: 150 + (idx % 2 === 1 ? 60 : -20),
            status: idx === 0 ? 'completed' : (idx === 1 ? 'running' : 'pending'),
            details: `Workflow stage for ${lbl}`
        }));

        const edges: GraphEdge[] = [];
        for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({
                id: `edge-${i + 1}-${i + 2}`,
                source: nodes[i].id,
                target: nodes[i + 1].id,
                style: 'animated'
            });
        }

        const nodeGraphData: NodeGraphData = {
            title: `${doc.title} — Architecture Flow`,
            subtitle: `Automated visual execution DAG mapped from specification`,
            nodes,
            edges
        };

        onMorphToNodeGraph(nodeGraphData);
    };

    // Render the interactive block inserter bar
    const renderInserter = (index: number) => {
        if (readOnly) return null;
        const isOpen = activeInserterIndex === index;

        return (
            <div className={`sb-doc-inserter-zone sb-doc-block-inserter ${isOpen ? 'sb-inserter-open' : ''}`}>
                <div className="sb-doc-inserter-line" />
                {!isOpen ? (
                    <button
                        type="button"
                        className="sb-doc-inserter-trigger-btn"
                        onClick={() => setActiveInserterIndex(index)}
                        title="Add content block here"
                    >
                        <IconPlus size={11} strokeWidth={2.5} />
                        <span className="sb-inserter-hint-text">Add block</span>
                    </button>
                ) : (
                    <div className="sb-doc-inserter-popup animate-popover">
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'heading')}
                        >
                            <span className="sb-inserter-item-icon">H</span>
                            <span>Heading</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'paragraph')}
                        >
                            <span className="sb-inserter-item-icon">¶</span>
                            <span>Paragraph</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'editorial-image')}
                        >
                            <IconImage size={13} strokeWidth={1.8} />
                            <span>Image</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'location-image')}
                        >
                            <IconPin size={13} strokeWidth={1.8} />
                            <span>Map</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'svg-diagram')}
                        >
                            <IconDiagram size={13} strokeWidth={1.8} />
                            <span>Diagram</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'video')}
                        >
                            <IconVideo size={13} strokeWidth={1.8} />
                            <span>Video</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'citation')}
                        >
                            <IconCitation size={13} strokeWidth={1.8} />
                            <span>Citations</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'callout')}
                        >
                            <IconCallout size={13} strokeWidth={1.8} />
                            <span>Callout</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'table')}
                        >
                            <IconTable size={13} strokeWidth={1.8} />
                            <span>Table</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'checklist')}
                        >
                            <IconChecklist size={13} strokeWidth={1.8} />
                            <span>Checklist</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-item-btn"
                            onClick={() => handleAddSection(index, 'code')}
                        >
                            <IconCode size={13} strokeWidth={1.8} />
                            <span>Code</span>
                        </button>
                        <button
                            type="button"
                            className="sb-inserter-close-btn"
                            onClick={() => setActiveInserterIndex(undefined)}
                            title="Cancel"
                        >
                            <IconClose size={11} />
                        </button>
                    </div>
                )}
            </div>
        );
    };

    const renderSection = (section: MarkdownSection, index: number) => {
        const isHovered = activeSectionId === section.id;
        const isEditing = editingSectionId === section.id;
        const isSectionStreaming = isStreaming && (streamingSectionId === section.id || (!streamingSectionId && index === (doc.sections || []).length - 1));

        return (
            <div
                key={section.id}
                id={`doc-sec-${section.id}`}
                className={`sb-doc-section-wrapper ${isHovered ? 'sb-section-active' : ''} ${isEditing ? 'sb-section-editing' : ''} ${isSectionStreaming ? 'sb-doc-section-streaming' : ''}`}
                onMouseEnter={() => setActiveSectionId(section.id)}
                onMouseLeave={() => setActiveSectionId(undefined)}
            >
                {/* Section Content Rendering / Direct In-Place Edit */}
                {section.type === 'heading' && (
                    <div className="sb-doc-heading-row">
                        {isEditing ? (
                            <input
                                autoFocus
                                className={`sb-doc-seamless-input sb-doc-h${section.level || 2}-input`}
                                value={section.content || ''}
                                onChange={e => handleUpdateSection(section.id, { content: e.target.value })}
                                onBlur={() => setEditingSectionId(undefined)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' || e.key === 'Escape') {
                                        setEditingSectionId(undefined);
                                    }
                                }}
                                placeholder="Section Heading..."
                            />
                        ) : (
                            <div
                                className="sb-doc-editable-block"
                                onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                title={readOnly ? undefined : "Click to edit heading"}
                            >
                                {section.level === 1 && <h2 className="sb-doc-h1"><InlineMarkdown text={section.content && !/^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3})$/i.test(section.content.trim()) ? section.content : '1. Executive Overview & Foundations'} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />{isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}</h2>}
                                {section.level === 2 && <h3 className="sb-doc-h2"><InlineMarkdown text={section.content && !/^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3})$/i.test(section.content.trim()) ? section.content : '2. Key Technical Pillars & Analysis'} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />{isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}</h3>}
                                {(!section.level || section.level === 3) && <h4 className="sb-doc-h3"><InlineMarkdown text={section.content && !/^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3})$/i.test(section.content.trim()) ? section.content : '3. Implementation Details'} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />{isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}</h4>}
                            </div>
                        )}
                    </div>
                )}

                {section.type === 'paragraph' && (
                    <div className="sb-doc-paragraph-row">
                        {isEditing ? (
                            <textarea
                                autoFocus
                                className="sb-doc-seamless-textarea"
                                value={section.content || ''}
                                onChange={e => {
                                    handleUpdateSection(section.id, { content: e.target.value });
                                    const target = e.currentTarget;
                                    target.style.height = 'auto';
                                    target.style.height = `${target.scrollHeight}px`;
                                }}
                                onInput={e => {
                                    const target = e.currentTarget;
                                    target.style.height = 'auto';
                                    target.style.height = `${target.scrollHeight}px`;
                                }}
                                onBlur={() => setEditingSectionId(undefined)}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') {
                                        setEditingSectionId(undefined);
                                    } else if (e.key === 'Backspace' && (!section.content || section.content === '' || e.currentTarget.value === '')) {
                                        e.preventDefault();
                                        handleDeleteSection(section.id);
                                    }
                                }}
                                ref={el => {
                                    if (el) {
                                        el.style.height = 'auto';
                                        el.style.height = `${el.scrollHeight}px`;
                                    }
                                }}
                                placeholder="Write paragraph content..."
                            />
                        ) : (
                            <div
                                className="sb-doc-editable-block"
                                onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                title={readOnly ? undefined : "Click to edit paragraph"}
                            >
                                <p className="sb-doc-p">
                                    <InlineMarkdown text={section.content || ''} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />
                                    {isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}
                                </p>
                            </div>
                        )}
                    </div>
                )}

                {/* Multi-Modal Block 1: Clean Editorial Location & Spatial Imagery */}
                {section.type === 'location-image' && (() => {
                    const currentImgUrl = section.imageUrl || 'https://images.unsplash.com/photo-1575881875475-31024b156660?auto=format&fit=crop&w=1600&q=85';
                    const displayTitle = section.locationName || section.imageTitle || 'Geographic Landmark';
                    const displayCaption = section.caption || 'Historical location context and geographic setting supporting this narrative specification.';
                    const displayDateTag = section.dateTag || (section.locationName ? section.locationName.split(',')[0] : 'Historical Landmark');
                    const displayAttribution = section.attribution || (section.coordinates ? `Historical Landmark • ${section.coordinates.lat.toFixed(4)}° N, ${Math.abs(section.coordinates.lng).toFixed(4)}° W` : 'Historical Landmark');

                    return (
                        <figure className="sb-editorial-image-card sb-doc-editorial-image-card sb-doc-location-card group">
                            <div className="sb-editorial-image-frame sb-location-media-frame">
                                <img
                                    src={currentImgUrl}
                                    alt={displayTitle}
                                    className="sb-editorial-image-element sb-location-image-element"
                                    loading="lazy"
                                    onError={(e) => {
                                        const target = e.currentTarget;
                                        const fallback = getLocationFallbackSvg(displayTitle, displayDateTag, displayAttribution, doc.title);
                                        if (target.src !== fallback) {
                                            target.src = fallback;
                                        }
                                    }}
                                    onClick={() => setLightboxImage({
                                        url: currentImgUrl,
                                        title: displayTitle,
                                        caption: displayCaption,
                                        attribution: displayAttribution,
                                        dateTag: displayDateTag
                                    })}
                                />
                                <div className="sb-editorial-image-scrim" />
                                {displayDateTag && (
                                    <div className="sb-editorial-badge sb-location-context-label">
                                        <span>{displayDateTag}</span>
                                    </div>
                                )}
                                <div className="sb-editorial-overlay-actions sb-location-overlay-actions">
                                    <button
                                        type="button"
                                        className="sb-btn sb-editorial-action-btn sb-location-zoom-action"
                                        onClick={() => setLightboxImage({
                                            url: currentImgUrl,
                                            title: displayTitle,
                                            caption: displayCaption,
                                            attribution: displayAttribution,
                                            dateTag: displayDateTag
                                        })}
                                        aria-label={`Zoom location image: ${displayTitle}`}
                                        title={`Zoom location image: ${displayTitle}`}
                                    >
                                        <IconZoomIn size={13} />
                                        <span>Zoom</span>
                                    </button>
                                </div>
                            </div>
                            <figcaption className="sb-editorial-caption-area sb-location-caption-area">
                                <div className="sb-editorial-header-row sb-location-header-row">
                                    {isEditing ? (
                                        <input
                                            autoFocus
                                            className="sb-doc-seamless-input sb-editorial-title-input sb-location-title-input"
                                            value={section.locationName || section.imageTitle || ''}
                                            onChange={e => handleUpdateSection(section.id, {
                                                locationName: e.target.value,
                                                imageTitle: e.target.value
                                            })}
                                            onBlur={() => setEditingSectionId(undefined)}
                                            placeholder="Location title..."
                                        />
                                    ) : (
                                        <h4
                                            className="sb-editorial-title-text sb-location-title-text"
                                            onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                            title="Click to edit location title"
                                        >
                                            {displayTitle}
                                        </h4>
                                    )}
                                </div>
                                {isEditing ? (
                                    <textarea
                                        className="sb-doc-seamless-textarea sb-editorial-caption-textarea sb-location-caption-textarea"
                                        value={section.caption || ''}
                                        onChange={e => handleUpdateSection(section.id, { caption: e.target.value })}
                                        onBlur={() => setEditingSectionId(undefined)}
                                        placeholder="Write location narrative caption..."
                                    />
                                ) : (
                                    <p
                                        className="sb-editorial-caption-text sb-location-caption-text"
                                        onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                        title="Click to edit narrative caption"
                                    >
                                        {displayCaption}
                                    </p>
                                )}
                                <div className="sb-editorial-footer-row sb-location-footer-row">
                                    <span className="sb-editorial-attribution-text sb-location-metadata" title={displayAttribution}>
                                        {displayAttribution}
                                    </span>
                                    {(section.visualPrompt || section.prompt) && (
                                        <details className="sb-editorial-prompt-disclosure sb-location-prompt-disclosure">
                                            <summary className="sb-prompt-summary">Visual context</summary>
                                            <div className="sb-prompt-details-body">
                                                {section.visualPrompt || section.prompt}
                                            </div>
                                        </details>
                                    )}
                                </div>
                                {/* Inline Prompt Box at bottom */}
                                {!readOnly && (
                                    <div className="sb-node-prompt-box" style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        background: 'rgba(0, 0, 0, 0.25)',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(255, 255, 255, 0.12)',
                                        padding: '2px 6px',
                                        marginTop: '10px',
                                        width: '100%'
                                    }}>
                                        <IconSparkles size={11} color="var(--sb-system-cyan)" />
                                        <input
                                            type="text"
                                            value={section.prompt || section.visualPrompt || ''}
                                            placeholder="Describe changes or style..."
                                            onChange={e => handleUpdateSection(section.id, { prompt: e.target.value, visualPrompt: e.target.value })}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleNanoBananaRegenerate(section);
                                                }
                                            }}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                outline: 'none',
                                                fontSize: '11px',
                                                color: 'var(--sb-text-label)',
                                                flex: 1,
                                                minWidth: 0,
                                                padding: '4px 0'
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className="sb-btn sb-prompt-submit-btn"
                                            onClick={() => handleNanoBananaRegenerate(section)}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                cursor: 'pointer',
                                                color: 'var(--sb-system-cyan)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                padding: '2px'
                                            }}
                                        >
                                            <IconPlay size={10} />
                                        </button>
                                    </div>
                                )}
                            </figcaption>
                        </figure>
                    );
                })()}

                {/* Multi-Modal Block 2: Clean Modern Editorial Image Card (Nano Banana Synthesis) */}
                {(section.type === 'editorial-image' || section.type === 'image') && (() => {
                    const isRegenerating = Boolean(regeneratingImages[section.id]);
                    const isStyleMenuOpen = openStyleMenuSectionId === section.id;
                    const currentImgUrl = section.imageUrl || section.thumbnailUrl || 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&w=1600&q=85';
                    const displayTitle = section.imageTitle || section.locationName || 'Visual Reconstruction & Narrative Context';
                    const displayCaption = section.caption || section.description || 'High-fidelity editorial visual reconstruction supporting this narrative specification.';
                    const displayDateTag = section.dateTag || 'Historical Archive';
                    const displayAttribution = section.attribution || 'Visual Archive • Nano Banana Synthesis';

                    return (
                        <figure className="sb-editorial-image-card sb-doc-editorial-image-card group">
                            {/* Image Frame Viewport */}
                            <div className="sb-editorial-image-frame">
                                <img
                                    src={currentImgUrl}
                                    alt={displayTitle}
                                    className={`sb-editorial-image-element ${isRegenerating ? 'sb-image-loading' : ''}`}
                                    loading="lazy"
                                    onError={(e) => {
                                        const target = e.currentTarget;
                                        const fallback = getTopicFallbackSvg(displayTitle, displayDateTag, doc.title);
                                        if (target.src !== fallback) {
                                            target.src = fallback;
                                        }
                                    }}
                                    onClick={() => setLightboxImage({
                                        url: currentImgUrl,
                                        title: displayTitle,
                                        caption: displayCaption,
                                        attribution: displayAttribution,
                                        dateTag: displayDateTag,
                                        prompt: section.visualPrompt || section.prompt,
                                        stylePreset: section.stylePreset
                                    })}
                                />

                                {/* Subtle gradient scrim */}
                                <div className="sb-editorial-image-scrim" />

                                {/* Date / Era / Domain Tag Badge */}
                                {displayDateTag && (
                                    <div className="sb-editorial-badge">
                                        <span>{displayDateTag}</span>
                                    </div>
                                )}

                                {/* Hover Action Overlay Toolbar */}
                                <div className="sb-editorial-overlay-actions">
                                    <button
                                        type="button"
                                        className="sb-btn sb-editorial-action-btn"
                                        onClick={() => setLightboxImage({
                                            url: currentImgUrl,
                                            title: displayTitle,
                                            caption: displayCaption,
                                            attribution: displayAttribution,
                                            dateTag: displayDateTag,
                                            prompt: section.visualPrompt || section.prompt,
                                            stylePreset: section.stylePreset
                                        })}
                                        title="Click to Zoom / Lightbox Preview"
                                    >
                                        <IconZoomIn size={13} />
                                        <span>Zoom</span>
                                    </button>

                                    <button
                                        type="button"
                                        className="sb-btn sb-editorial-action-btn sb-btn-nano-banana"
                                        onClick={() => handleNanoBananaRegenerate(section)}
                                        disabled={isRegenerating}
                                        title="Regenerate with Nano Banana Image AI"
                                    >
                                        <IconSparkles size={13} />
                                        <span>{isRegenerating ? 'Generating...' : 'Regenerate'}</span>
                                    </button>

                                    <div className="sb-editorial-style-dropdown-container">
                                        <button
                                            type="button"
                                            className="sb-btn sb-editorial-action-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenStyleMenuSectionId(isStyleMenuOpen ? null : section.id);
                                            }}
                                            title="Choose Nano Banana Art Style"
                                        >
                                            <IconPalette size={13} />
                                            <span>Style ▾</span>
                                        </button>

                                        {isStyleMenuOpen && (
                                            <div className="sb-editorial-style-menu animate-popover" onClick={e => e.stopPropagation()}>
                                                <div className="sb-style-menu-header">Nano Banana Styles</div>
                                                {NANO_BANANA_STYLES.map(st => (
                                                    <button
                                                        key={st.id}
                                                        type="button"
                                                        className="sb-btn sb-style-menu-item"
                                                        onClick={() => handleNanoBananaRegenerate(section, st.id)}
                                                    >
                                                        <span className="sb-style-name">{st.label}</span>
                                                        <span className="sb-style-hint">{st.hint}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Loading Shimmer Overlay */}
                                {isRegenerating && (
                                    <div className="sb-editorial-loading-overlay">
                                        <div className="sb-editorial-loading-spinner" />
                                        <span className="sb-editorial-loading-text">Nano Banana synthesizing visual...</span>
                                    </div>
                                )}
                            </div>

                            {/* Clean Editorial Caption Area Below */}
                            <figcaption className="sb-editorial-caption-area">
                                <div className="sb-editorial-header-row">
                                    {isEditing ? (
                                        <input
                                            autoFocus
                                            className="sb-doc-seamless-input sb-editorial-title-input"
                                            value={section.imageTitle || ''}
                                            onChange={e => handleUpdateSection(section.id, {
                                                imageTitle: e.target.value
                                            })}
                                            onBlur={() => setEditingSectionId(undefined)}
                                            placeholder="Image title / caption..."
                                        />
                                    ) : (
                                        <h4
                                            className="sb-editorial-title-text"
                                            onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                            title="Click to edit title"
                                        >
                                            {displayTitle}
                                        </h4>
                                    )}
                                </div>

                                {/* Narrative Caption */}
                                {isEditing ? (
                                    <textarea
                                        className="sb-doc-seamless-textarea sb-editorial-caption-textarea"
                                        value={section.caption || section.description || ''}
                                        onChange={e => handleUpdateSection(section.id, {
                                            caption: e.target.value,
                                            description: e.target.value
                                        })}
                                        onBlur={() => setEditingSectionId(undefined)}
                                        placeholder="Write detailed editorial caption..."
                                    />
                                ) : (
                                    <p
                                        className="sb-editorial-caption-text"
                                        onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                        title="Click to edit narrative caption"
                                    >
                                        {displayCaption}
                                    </p>
                                )}

                                {/* Footer Attribution & Prompt Disclosure */}
                                <div className="sb-editorial-footer-row">
                                    <span className="sb-editorial-attribution-text">
                                        {displayAttribution}
                                    </span>

                                    {(section.visualPrompt || section.prompt) && (
                                        <details className="sb-editorial-prompt-disclosure">
                                            <summary className="sb-prompt-summary">
                                                <span className="sb-prompt-summary-icon">✨</span>
                                                <span className="sb-prompt-summary-title">Nano Banana Prompt</span>
                                                {section.stylePreset && (
                                                    <span className="sb-prompt-summary-badge">{section.stylePreset}</span>
                                                )}
                                            </summary>
                                            <div className="sb-prompt-details-body">
                                                <div className="sb-prompt-text-display">
                                                    {section.visualPrompt || section.prompt}
                                                </div>
                                                <div className="sb-prompt-actions-bar">
                                                    <span className="sb-prompt-char-count">{(section.visualPrompt || section.prompt || '').length} chars • Nano Banana Pro Contextual Engine</span>
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-prompt-copy-btn"
                                                        onClick={(e) => handleCopyPrompt(section.id, section.visualPrompt || section.prompt || '', e)}
                                                        title="Copy prompt to clipboard"
                                                    >
                                                        {copiedPromptSectionId === section.id ? (
                                                            <>
                                                                <IconCheck size={12} />
                                                                <span>Copied!</span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <IconCopy size={12} />
                                                                <span>Copy Prompt</span>
                                                            </>
                                                        )}
                                                    </button>
                                                </div>
                                            </div>
                                        </details>
                                    )}
                                </div>
                                {/* Inline Prompt Box at bottom */}
                                {!readOnly && (
                                    <div className="sb-node-prompt-box" style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        background: 'rgba(0, 0, 0, 0.25)',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(255, 255, 255, 0.12)',
                                        padding: '2px 6px',
                                        marginTop: '10px',
                                        width: '100%'
                                    }}>
                                        <IconSparkles size={11} color="var(--sb-system-purple)" />
                                        <input
                                            type="text"
                                            value={section.prompt || section.visualPrompt || ''}
                                            placeholder="Describe image scenery or style..."
                                            onChange={e => handleUpdateSection(section.id, { prompt: e.target.value, visualPrompt: e.target.value })}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleNanoBananaRegenerate(section);
                                                }
                                            }}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                outline: 'none',
                                                fontSize: '11px',
                                                color: 'var(--sb-text-label)',
                                                flex: 1,
                                                minWidth: 0,
                                                padding: '4px 0'
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className="sb-btn sb-prompt-submit-btn"
                                            onClick={() => handleNanoBananaRegenerate(section)}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                cursor: 'pointer',
                                                color: 'var(--sb-system-purple)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                padding: '2px'
                                            }}
                                        >
                                            <IconPlay size={10} />
                                        </button>
                                    </div>
                                )}
                            </figcaption>
                        </figure>
                    );
                })()}

                {/* Multi-Modal Block 2b: Clean Video Walkthrough Card */}
                {section.type === 'video' && (() => {
                    const isRegenerating = Boolean(regeneratingImages[section.id]);
                    const isStyleMenuOpen = openStyleMenuSectionId === section.id;
                    const currentImgUrl = section.imageUrl || section.thumbnailUrl || 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&w=1600&q=85';
                    const displayTitle = section.videoTitle || section.imageTitle || 'Video Walkthrough';
                    const displayCaption = section.caption || section.description || 'Walkthrough and timeline simulation.';
                    const displayDuration = section.duration || '03:00';
                    const displayAttribution = section.attribution || 'Visual Simulation Archive';

                    return (
                        <figure className="sb-editorial-image-card sb-doc-editorial-image-card sb-doc-video-card group">
                            <div className="sb-editorial-image-frame relative">
                                <img
                                    src={currentImgUrl}
                                    alt={displayTitle}
                                    className={`sb-editorial-image-element ${isRegenerating ? 'sb-image-loading' : ''}`}
                                    loading="lazy"
                                    onError={(e) => {
                                        const target = e.currentTarget;
                                        const fallback = getTopicFallbackSvg(displayTitle, `Duration: ${displayDuration}`, doc.title);
                                        if (target.src !== fallback) {
                                            target.src = fallback;
                                        }
                                    }}
                                    onClick={() => setLightboxImage({
                                        url: currentImgUrl,
                                        title: displayTitle,
                                        caption: displayCaption,
                                        attribution: displayAttribution,
                                        dateTag: `Duration: ${displayDuration}`,
                                        prompt: section.visualPrompt || section.prompt,
                                        stylePreset: section.stylePreset
                                    })}
                                />
                                <div className="sb-editorial-image-scrim" />
                                <div className="sb-editorial-badge">
                                    <span>▶ {displayDuration}</span>
                                </div>
                                <div className="sb-editorial-overlay-actions">
                                    <button
                                        type="button"
                                        className="sb-btn sb-editorial-action-btn"
                                        onClick={() => setLightboxImage({
                                            url: currentImgUrl,
                                            title: displayTitle,
                                            caption: displayCaption,
                                            attribution: displayAttribution,
                                            dateTag: `Duration: ${displayDuration}`,
                                            prompt: section.visualPrompt || section.prompt,
                                            stylePreset: section.stylePreset
                                        })}
                                        title="Click to Zoom / Lightbox Preview"
                                    >
                                        <IconZoomIn size={13} />
                                        <span>Zoom</span>
                                    </button>

                                    <button
                                        type="button"
                                        className="sb-btn sb-editorial-action-btn sb-btn-nano-banana"
                                        onClick={() => handleNanoBananaRegenerate(section)}
                                        disabled={isRegenerating}
                                        title="Regenerate with Nano Banana Image AI"
                                    >
                                        <IconSparkles size={13} />
                                        <span>{isRegenerating ? 'Generating...' : 'Regenerate'}</span>
                                    </button>

                                    <div className="sb-editorial-style-dropdown-container">
                                        <button
                                            type="button"
                                            className="sb-btn sb-editorial-action-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenStyleMenuSectionId(isStyleMenuOpen ? null : section.id);
                                            }}
                                            title="Choose Nano Banana Art Style"
                                        >
                                            <IconPalette size={13} />
                                            <span>Style ▾</span>
                                        </button>

                                        {isStyleMenuOpen && (
                                            <div className="sb-editorial-style-menu animate-popover" onClick={e => e.stopPropagation()}>
                                                <div className="sb-style-menu-header">Nano Banana Styles</div>
                                                {NANO_BANANA_STYLES.map(st => (
                                                    <button
                                                        key={st.id}
                                                        type="button"
                                                        className="sb-btn sb-style-menu-item"
                                                        onClick={() => handleNanoBananaRegenerate(section, st.id)}
                                                    >
                                                        <span className="sb-style-name">{st.label}</span>
                                                        <span className="sb-style-hint">{st.hint}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Loading Shimmer Overlay */}
                                {isRegenerating && (
                                    <div className="sb-editorial-loading-overlay">
                                        <div className="sb-editorial-loading-spinner" />
                                        <span className="sb-editorial-loading-text">Nano Banana synthesizing visual...</span>
                                    </div>
                                )}
                            </div>
                            <figcaption className="sb-editorial-caption-area">
                                <div className="sb-editorial-header-row">
                                    {isEditing ? (
                                        <input
                                            autoFocus
                                            className="sb-doc-seamless-input sb-editorial-title-input"
                                            value={section.videoTitle || ''}
                                            onChange={e => handleUpdateSection(section.id, {
                                                videoTitle: e.target.value,
                                                imageTitle: e.target.value
                                            })}
                                            onBlur={() => setEditingSectionId(undefined)}
                                            placeholder="Video title..."
                                        />
                                    ) : (
                                        <h4
                                            className="sb-editorial-title-text"
                                            onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                            title="Click to edit title"
                                        >
                                            {displayTitle}
                                        </h4>
                                    )}
                                </div>
                                {isEditing ? (
                                    <textarea
                                        className="sb-doc-seamless-textarea sb-editorial-caption-textarea"
                                        value={section.caption || section.description || ''}
                                        onChange={e => handleUpdateSection(section.id, {
                                            caption: e.target.value,
                                            description: e.target.value
                                        })}
                                        onBlur={() => setEditingSectionId(undefined)}
                                        placeholder="Write video description..."
                                    />
                                ) : (
                                    <p
                                        className="sb-editorial-caption-text"
                                        onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                        title="Click to edit description"
                                    >
                                        {displayCaption}
                                    </p>
                                )}
                                {section.timelineEvents && section.timelineEvents.length > 0 && (
                                     <div className="sb-video-timeline-events" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--sb-surface-border)' }}>
                                         {section.timelineEvents.map((ev, idx) => (
                                             <div key={idx} className="sb-video-event-item" style={{ padding: '8px 10px', borderRadius: '8px', background: 'var(--sb-surface-card)', border: '1px solid var(--sb-surface-border)', fontSize: '12px' }}>
                                                 <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--sb-system-blue, #3b82f6)', marginBottom: '3px' }}>
                                                     <span style={{ fontFamily: 'monospace', fontSize: '11px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(59, 130, 246, 0.12)', color: 'var(--sb-system-blue, #3b82f6)' }}>{ev.time}</span>
                                                     <span>{ev.label}</span>
                                                 </div>
                                                 <div style={{ color: 'var(--sb-text-secondary)', fontSize: '11px', lineHeight: 1.35 }}>{ev.description}</div>
                                             </div>
                                         ))}
                                     </div>
                                 )}
                                <div className="sb-editorial-footer-row">
                                    <span className="sb-editorial-attribution-text">
                                        {displayAttribution}
                                    </span>

                                    {(section.visualPrompt || section.prompt) && (
                                        <details className="sb-editorial-prompt-disclosure">
                                            <summary className="sb-prompt-summary">
                                                <span className="sb-prompt-summary-icon">✨</span>
                                                <span className="sb-prompt-summary-title">Nano Banana Prompt</span>
                                                {section.stylePreset && (
                                                    <span className="sb-prompt-summary-badge">{section.stylePreset}</span>
                                                )}
                                            </summary>
                                            <div className="sb-prompt-details-body">
                                                <div className="sb-prompt-text-display">
                                                    {section.visualPrompt || section.prompt}
                                                </div>
                                                <div className="sb-prompt-actions-bar">
                                                    <span className="sb-prompt-char-count">{(section.visualPrompt || section.prompt || '').length} chars • Nano Banana Pro Contextual Engine</span>
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-prompt-copy-btn"
                                                        onClick={(e) => handleCopyPrompt(section.id, section.visualPrompt || section.prompt || '', e)}
                                                        title="Copy prompt to clipboard"
                                                    >
                                                        {copiedPromptSectionId === section.id ? (
                                                            <>
                                                                <IconCheck size={12} />
                                                                <span>Copied!</span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <IconCopy size={12} />
                                                                <span>Copy Prompt</span>
                                                            </>
                                                        )}
                                                    </button>
                                                </div>
                                            </div>
                                        </details>
                                    )}
                                </div>
                                {/* Inline Prompt Box at bottom */}
                                {!readOnly && (
                                    <div className="sb-node-prompt-box" style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        background: 'rgba(0, 0, 0, 0.25)',
                                        borderRadius: '8px',
                                        border: '1px solid rgba(255, 255, 255, 0.12)',
                                        padding: '2px 6px',
                                        marginTop: '10px',
                                        width: '100%'
                                    }}>
                                        <IconSparkles size={11} color="var(--sb-system-rose)" />
                                        <input
                                            type="text"
                                            value={section.prompt || section.visualPrompt || ''}
                                            placeholder="Describe motion or camera move..."
                                            onChange={e => handleUpdateSection(section.id, { prompt: e.target.value, visualPrompt: e.target.value })}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleNanoBananaRegenerate(section);
                                                }
                                            }}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                outline: 'none',
                                                fontSize: '11px',
                                                color: 'var(--sb-text-label)',
                                                flex: 1,
                                                minWidth: 0,
                                                padding: '4px 0'
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className="sb-btn sb-prompt-submit-btn"
                                            onClick={() => handleNanoBananaRegenerate(section)}
                                            style={{
                                                background: 'transparent',
                                                border: 'none',
                                                cursor: 'pointer',
                                                color: 'var(--sb-system-rose)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                padding: '2px'
                                            }}
                                        >
                                            <IconPlay size={10} />
                                        </button>
                                    </div>
                                )}
                            </figcaption>
                        </figure>
                    );
                })()}

                {/* Multi-Modal Block 3: Clean Editorial SVG Diagrams & Charts */}
                {section.type === 'svg-diagram' && (
                    <div className="sb-doc-svg-card">
                        <div className="sb-svg-card-header">
                            <div className="sb-svg-header-left">
                                <span className="sb-svg-icon-badge">
                                    <IconDiagram size={13} strokeWidth={2} />
                                </span>
                                {isEditing ? (
                                    <input
                                        autoFocus
                                        className="sb-doc-seamless-input sb-svg-title-input"
                                        value={section.diagramTitle || ''}
                                        onChange={e => handleUpdateSection(section.id, { diagramTitle: e.target.value })}
                                        onBlur={() => setEditingSectionId(undefined)}
                                        placeholder="Diagram Title..."
                                    />
                                ) : (
                                    <span
                                        className="sb-svg-title-text"
                                        onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                    >
                                        {section.diagramTitle || 'Interactive Diagram'}
                                    </span>
                                )}
                            </div>
                            <div className="sb-svg-header-meta">
                                <span className="sb-svg-type-badge">
                                    {(section.diagramType || 'DIAGRAM').toUpperCase()}
                                </span>
                            </div>
                        </div>

                        {/* SVG Visual Canvas Rendering */}
                        <div
                            className="sb-doc-svg-canvas-wrapper"
                            dangerouslySetInnerHTML={{ __html: section.svgContent || '<svg></svg>' }}
                        />

                        {/* Interactive Node Inspector Pills */}
                        {section.interactiveNodes && section.interactiveNodes.length > 0 && (
                            <div className="sb-svg-nodes-strip">
                                <span className="sb-svg-nodes-heading">Nodes &amp; Gateways:</span>
                                <div className="sb-svg-nodes-buttons">
                                    {section.interactiveNodes.map(node => {
                                        const isSelected = selectedDiagramNodes[section.id] === node.id;
                                        return (
                                            <button
                                                key={node.id}
                                                type="button"
                                                className={`sb-svg-node-pill ${isSelected ? 'sb-node-pill-selected' : ''}`}
                                                onClick={e => handleSelectDiagramNode(section.id, node.id, e)}
                                            >
                                                {node.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Selected Node Details Card */}
                        {selectedDiagramNodes[section.id] && (() => {
                            const node = section.interactiveNodes?.find(n => n.id === selectedDiagramNodes[section.id]);
                            if (!node) return null;
                            return (
                                <div className="sb-svg-node-detail-card animate-fadeIn">
                                    <div className="sb-node-detail-header">
                                        <span className="sb-node-detail-title">{node.label}</span>
                                        <button
                                            type="button"
                                            className="sb-node-detail-close"
                                            onClick={() => handleSelectDiagramNode(section.id, node.id)}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                    <p className="sb-node-detail-desc">{node.detail || 'Standard pipeline node interface contract.'}</p>
                                </div>
                            );
                        })()}
                    </div>
                )}

                {/* Multi-Modal Block 4: Grounded Citations & Primary Sources */}
                {section.type === 'citation' && (
                    <div className="sb-doc-citations-container">
                        <div className="sb-citations-header">
                            <div className="sb-citations-header-title">
                                <span className="sb-citations-icon-badge">
                                    <IconCitation size={13} strokeWidth={2} />
                                </span>
                                <span className="sb-citations-title-text">Primary Sources &amp; References</span>
                                <span className="sb-citations-count-pill">{section.citationItems?.length || 0} Sources</span>
                            </div>
                            <span className="sb-citations-verified-badge">
                                ✓ Verified Sources
                            </span>
                        </div>

                        <div className="sb-doc-citations-grid">
                            {(section.citationItems || []).map((cite, citeIdx) => {
                                const domain = extractDomain(cite.url);
                                const displayTitle = cite.sourceTitle || domain || cite.url || `Reference [${citeIdx + 1}]`;
                                const isDomainInTitle = Boolean(domain && displayTitle.toLowerCase().includes(domain.toLowerCase()));
                                const secondaryMeta = !isDomainInTitle && domain
                                    ? domain
                                    : (cite.archiveName && cite.archiveName !== 'Google Search Grounding' ? cite.archiveName : cite.year ? `(${cite.year})` : undefined);

                                const tooltipParts = [
                                    cite.sourceTitle,
                                    cite.author && cite.author !== 'Archival Reference' ? `Author: ${cite.author}` : null,
                                    cite.archiveName ? `Archive: ${cite.archiveName}` : null,
                                    cite.year ? `Year: ${cite.year}` : null,
                                    cite.badgeText ? `Type: ${cite.badgeText}` : null,
                                    cite.quoteSnippet ? `"${cite.quoteSnippet}"` : null,
                                    cite.url ? `URL: ${cite.url}` : null
                                ].filter(Boolean);

                                return (
                                    <a
                                        key={cite.id || `cite-${citeIdx}`}
                                        href={cite.url || '#'}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="sb-citation-link-row sb-citation-card"
                                        title={tooltipParts.join(' • ')}
                                        onClick={e => {
                                            if (cite.url && onOpenInBrowser) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onOpenInBrowser(cite.url, cite.sourceTitle || domain || cite.url);
                                            }
                                        }}
                                    >
                                        <div className="sb-citation-link-left">
                                            <span className="sb-citation-index">[{citeIdx + 1}]</span>
                                            <span className="sb-citation-link-title" title={cite.sourceTitle}>
                                                {displayTitle}
                                            </span>
                                            {secondaryMeta && (
                                                <span className="sb-citation-link-meta">
                                                    • {secondaryMeta}
                                                </span>
                                            )}
                                        </div>
                                        <span className="sb-citation-link-icon">
                                            <IconExternalLink size={11} strokeWidth={2} />
                                        </span>
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                )}

                {section.type === 'callout' && (
                    <div className={`sb-doc-callout sb-callout-${section.calloutType || 'info'}`}>
                        {section.calloutType === 'ai' && (
                            <div className="sb-callout-ai-header">
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span className="sb-callout-badge-ai">
                                        <IconSparkles size={11} />
                                        <span>{section.aiProvenance?.model || 'Gemini 2.5 Pro'}</span>
                                    </span>
                                    {section.aiProvenance?.timestamp && (
                                        <span className="sb-ai-provenance-meta">{section.aiProvenance.timestamp}</span>
                                    )}
                                    {section.aiProvenance?.prompt && (
                                        <span className="sb-ai-provenance-meta" title={section.aiProvenance.prompt}>
                                            • {section.aiProvenance.prompt.length > 32 ? section.aiProvenance.prompt.slice(0, 32) + '...' : section.aiProvenance.prompt}
                                        </span>
                                    )}
                                </div>
                                <div className="sb-ai-callout-actions">
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-xs sb-ai-provenance-btn"
                                        onClick={() => handleToggleAiCollapse(section.id)}
                                        title={section.aiProvenance?.isCollapsed ? "Expand AI Callout" : "Collapse AI Callout"}
                                    >
                                        <span>{section.aiProvenance?.isCollapsed ? 'Expand ▾' : 'Collapse ▴'}</span>
                                    </button>
                                    {!readOnly && (
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-secondary sb-btn-xs sb-ai-provenance-btn"
                                            onClick={() => handlePromoteAiCallout(section.id)}
                                            title="Promote AI Callout to regular document body paragraph"
                                        >
                                            <span>Promote to Body</span>
                                        </button>
                                    )}
                                    {!readOnly && (
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-secondary sb-btn-xs sb-ai-provenance-btn"
                                            onClick={e => handleDeleteSection(section.id, e)}
                                            title="Dismiss AI Callout"
                                        >
                                            <IconTrash size={11} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {section.calloutType === 'ai' && section.aiProvenance?.isCollapsed ? (
                            <div
                                className="sb-doc-editable-block"
                                style={{ padding: '6px 0', opacity: 0.75, fontStyle: 'italic', fontSize: '13px', cursor: 'pointer' }}
                                onClick={() => handleToggleAiCollapse(section.id)}
                                title="Click to expand AI Callout"
                            >
                                <span>{section.calloutTitle || 'AI Provenance & Synthesis'} ({(section.content || '').length} characters collapsed) — click to expand</span>
                            </div>
                        ) : (
                            <div className="sb-callout-body">
                                {isEditing ? (
                                    <div className="sb-callout-seamless-edit">
                                        <input
                                            className="sb-callout-title-seamless"
                                            value={section.calloutTitle || ''}
                                            onChange={e => handleUpdateSection(section.id, { calloutTitle: e.target.value })}
                                            onBlur={() => setEditingSectionId(undefined)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' || e.key === 'Escape') setEditingSectionId(undefined);
                                            }}
                                            placeholder="Callout Title..."
                                        />
                                        <textarea
                                            autoFocus
                                            className="sb-callout-content-seamless"
                                            value={section.content || ''}
                                            onChange={e => {
                                                handleUpdateSection(section.id, { content: e.target.value });
                                                const target = e.currentTarget;
                                                target.style.height = 'auto';
                                                target.style.height = `${target.scrollHeight}px`;
                                            }}
                                            onInput={e => {
                                                const target = e.currentTarget;
                                                target.style.height = 'auto';
                                                target.style.height = `${target.scrollHeight}px`;
                                            }}
                                            onBlur={() => setEditingSectionId(undefined)}
                                            onKeyDown={e => { if (e.key === 'Escape') setEditingSectionId(undefined); }}
                                            ref={el => {
                                                if (el) {
                                                    el.style.height = 'auto';
                                                    el.style.height = `${el.scrollHeight}px`;
                                                }
                                            }}
                                            placeholder="Callout body text..."
                                        />
                                    </div>
                                ) : (
                                    <div
                                        className="sb-doc-editable-block"
                                        onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                        title={readOnly ? undefined : "Click to edit callout"}
                                    >
                                        {section.calloutTitle && !/^(callout(\s+title)?\.{0,3}|title\.{0,3})$/i.test(section.calloutTitle.trim()) && (
                                            <h5 className="sb-callout-title"><InlineMarkdown text={section.calloutTitle} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} /></h5>
                                        )}
                                        <div className="sb-callout-text">
                                            <InlineMarkdown text={section.content || ''} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />
                                            {isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {section.type === 'quote' && (
                    <div className="sb-doc-quote-row">
                        {isEditing ? (
                            <blockquote className="sb-doc-quote">
                                <span className="sb-quote-mark">“</span>
                                <textarea
                                    autoFocus
                                    className="sb-doc-seamless-textarea sb-quote-textarea"
                                    value={section.content || ''}
                                    onChange={e => {
                                        handleUpdateSection(section.id, { content: e.target.value });
                                        const target = e.currentTarget;
                                        target.style.height = 'auto';
                                        target.style.height = `${target.scrollHeight}px`;
                                    }}
                                    onInput={e => {
                                        const target = e.currentTarget;
                                        target.style.height = 'auto';
                                        target.style.height = `${target.scrollHeight}px`;
                                    }}
                                    onBlur={() => setEditingSectionId(undefined)}
                                    onKeyDown={e => {
                                        if (e.key === 'Escape') {
                                            setEditingSectionId(undefined);
                                        } else if (e.key === 'Backspace' && (!section.content || section.content === '' || e.currentTarget.value === '')) {
                                            e.preventDefault();
                                            handleDeleteSection(section.id);
                                        }
                                    }}
                                    ref={el => {
                                        if (el) {
                                            el.style.height = 'auto';
                                            el.style.height = `${el.scrollHeight}px`;
                                        }
                                    }}
                                />
                            </blockquote>
                        ) : (
                            <blockquote
                                className="sb-doc-quote sb-doc-editable-block"
                                onClick={() => { if (!readOnly) setEditingSectionId(section.id); }}
                                title={readOnly ? undefined : "Click to edit quote"}
                            >
                                <span className="sb-quote-mark">“</span>
                                <div className="sb-quote-content">
                                    <InlineMarkdown text={section.content || ''} onOpenInBrowser={onOpenInBrowser} onOpenWikilink={handleWikilinkNavigation} />
                                    {isSectionStreaming && <span className="sb-chat-streaming-cursor animate-pulse">▊</span>}
                                </div>
                            </blockquote>
                        )}
                    </div>
                )}

                {section.type === 'table' && section.tableHeaders && section.tableRows && (
                    <div className="sb-doc-table-container">
                        <table className="sb-doc-table">
                            <thead>
                                <tr>
                                    {section.tableHeaders.map((header, idx) => (
                                        <th key={idx}>
                                            <textarea
                                                className="sb-table-cell-input sb-table-header-input"
                                                value={header}
                                                onChange={e => handleUpdateTableCell(section.id, 0, idx, e.target.value, true)}
                                                placeholder={`Col ${idx + 1}`}
                                                rows={Math.max(1, (header || '').split('\n').length)}
                                                readOnly={readOnly}
                                                onInput={e => {
                                                    const target = e.currentTarget;
                                                    target.style.height = 'auto';
                                                    target.style.height = `${target.scrollHeight}px`;
                                                }}
                                            />
                                        </th>
                                    ))}
                                    {!readOnly && (
                                        <th style={{ width: '38px', textAlign: 'center' }}>
                                            <button
                                                type="button"
                                                className="sb-table-mini-btn"
                                                onClick={() => handleAddTableColumn(section.id)}
                                                title="Add Column"
                                            >
                                                +
                                            </button>
                                        </th>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {section.tableRows.map((row, rowIdx) => (
                                    <tr key={rowIdx}>
                                        {row.map((cell, cellIdx) => (
                                            <td key={cellIdx}>
                                                <textarea
                                                    className="sb-table-cell-input"
                                                    value={cell}
                                                    onChange={e => handleUpdateTableCell(section.id, rowIdx, cellIdx, e.target.value, false)}
                                                    rows={Math.max(1, Math.min(6, (cell || '').split('\n').length))}
                                                    readOnly={readOnly}
                                                    onInput={e => {
                                                        const target = e.currentTarget;
                                                        target.style.height = 'auto';
                                                        target.style.height = `${target.scrollHeight}px`;
                                                    }}
                                                />
                                            </td>
                                        ))}
                                        {!readOnly && (
                                            <td style={{ textAlign: 'center' }}>
                                                <button
                                                    type="button"
                                                    className="sb-table-mini-btn sb-btn-del"
                                                    onClick={() => handleDeleteTableRow(section.id, rowIdx)}
                                                    title="Delete Row"
                                                >
                                                    ✕
                                                </button>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {!readOnly && (
                            <div className="sb-table-bottom-bar">
                                <button
                                    type="button"
                                    className="sb-table-action-pill"
                                    onClick={() => handleAddTableRow(section.id)}
                                >
                                    <IconPlus size={11} />
                                    <span>Add Row</span>
                                </button>
                                <button
                                    type="button"
                                    className="sb-table-action-pill"
                                    onClick={() => handleAddTableColumn(section.id)}
                                >
                                    <IconPlus size={11} />
                                    <span>Add Column</span>
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {section.type === 'checklist' && section.checklistItems && (
                    <div className="sb-doc-checklist">
                        {section.checklistItems.map(item => (
                            <div
                                key={item.id}
                                className={`sb-doc-check-row ${item.done ? 'sb-doc-item-done' : ''}`}
                            >
                                <label className="sb-doc-check-label">
                                    <input
                                        type="checkbox"
                                        checked={item.done}
                                        onChange={() => handleToggleChecklist(section.id, item.id)}
                                    />
                                    <span className="sb-doc-check-box" />
                                </label>
                                <input
                                    className="sb-doc-check-input"
                                    value={item.text}
                                    onChange={e => handleUpdateChecklistText(section.id, item.id, e.target.value)}
                                    placeholder="Task description..."
                                />
                                <button
                                    type="button"
                                    className="sb-checklist-item-del"
                                    onClick={() => handleDeleteChecklistItem(section.id, item.id)}
                                    title="Delete item"
                                >
                                    <IconClose size={10} />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            className="sb-checklist-add-btn"
                            onClick={() => handleAddChecklistItem(section.id)}
                        >
                            <IconPlus size={11} />
                            <span>Add checklist item</span>
                        </button>
                    </div>
                )}

                {section.type === 'badge-grid' && section.badgeItems && (
                    <div className="sb-doc-badges-grid">
                        {section.badgeItems.map((badge, bIdx) => (
                            <div key={bIdx} className={`sb-doc-badge-card sb-accent-${badge.color || 'blue'}`}>
                                <span className="sb-doc-badge-label">{badge.label}</span>
                                <span className="sb-doc-badge-value">{badge.value}</span>
                            </div>
                        ))}
                    </div>
                )}

                {section.type === 'code' && (
                    <div className="sb-doc-code-block">
                        <div className="sb-doc-code-header">
                            <div className="sb-doc-code-lang-badge">
                                <IconCode size={12} className="text-blue-400" />
                                <span>{(section.codeLanguage || section.language || (section.content?.includes('import ') || section.content?.includes('export ') ? 'typescript' : section.content?.startsWith('{') || section.content?.startsWith('[') ? 'json' : section.content?.includes('def ') ? 'python' : 'bash')).toUpperCase()}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    className="sb-code-copy-btn"
                                    onClick={e => handleCopyCode(section.id, section.content || '', e)}
                                    title="Copy code to clipboard"
                                >
                                    {copiedCodeSectionId === section.id ? (
                                        <>
                                            <IconCheck size={11} className="text-emerald-400" />
                                            <span className="text-emerald-400 font-medium">Copied</span>
                                        </>
                                    ) : (
                                        <>
                                            <IconCopy size={11} />
                                            <span>Copy</span>
                                        </>
                                    )}
                                </button>
                                {!readOnly && (
                                    <button
                                        type="button"
                                        className="sb-code-edit-toggle"
                                        onClick={() => setEditingSectionId(isEditing ? undefined : section.id)}
                                    >
                                        {isEditing ? 'Done' : 'Edit'}
                                    </button>
                                )}
                            </div>
                        </div>
                        {isEditing ? (
                            <textarea
                                autoFocus
                                className="sb-doc-code-textarea font-mono"
                                value={section.content || ''}
                                onChange={e => handleUpdateSection(section.id, { content: e.target.value })}
                                rows={Math.max(4, (section.content || '').split('\n').length + 1)}
                            />
                        ) : (
                            <pre className="sb-doc-code-content">{section.content}</pre>
                        )}
                    </div>
                )}

                {/* Inline Diff Preview for AI Transformation */}
                {section.diffPreview && (
                    <div className="sb-doc-diff-view animate-fadeIn">
                        <div className="sb-diff-tag">
                            <IconSparkles size={12} />
                            <span>{section.diffPreview.actionLabel || 'Proposed AI Transformation'}</span>
                        </div>
                        <div className="sb-diff-del" title="Original text">
                            <strong>- </strong>
                            <InlineMarkdown text={section.diffPreview.originalText} onOpenWikilink={handleWikilinkNavigation} onOpenInBrowser={onOpenInBrowser} />
                        </div>
                        <div className="sb-diff-add" title="Proposed replacement">
                            <strong>+ </strong>
                            <InlineMarkdown text={section.diffPreview.proposedText} onOpenWikilink={handleWikilinkNavigation} onOpenInBrowser={onOpenInBrowser} />
                        </div>
                        <div className="sb-diff-actions">
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-xs sb-diff-accept-btn"
                                onClick={() => handleAcceptDiff(section.id)}
                                title="Accept proposed changes into document"
                            >
                                <IconCheck size={11} />
                                <span>Accept Changes</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-secondary sb-btn-xs sb-diff-reject-btn"
                                onClick={() => handleRejectDiff(section.id)}
                                title="Discard proposed changes"
                            >
                                <IconClose size={11} />
                                <span>Reject</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* Section Action Bar (Hovered) */}
                {isHovered && !isEditing && !readOnly && (
                    <div className="sb-doc-section-hover-bar animate-fadeIn">
                        <div className="sb-section-order-tools">
                            <button
                                type="button"
                                className="sb-section-order-btn"
                                onClick={e => handleMoveSection(index, 'up', e)}
                                disabled={index === 0}
                                title="Move up"
                            >
                                <IconArrowUp size={11} />
                            </button>
                            <button
                                type="button"
                                className="sb-section-order-btn"
                                onClick={e => handleMoveSection(index, 'down', e)}
                                disabled={index === (doc.sections || []).length - 1}
                                title="Move down"
                            >
                                <IconArrowDown size={11} />
                            </button>
                            <button
                                type="button"
                                className="sb-section-order-btn sb-btn-danger"
                                onClick={e => handleDeleteSection(section.id, e)}
                                title="Delete section"
                            >
                                <IconTrash size={11} />
                            </button>
                        </div>

                        {/* Inline AI Quick Edit Tooltip */}
                        <div className="sb-doc-inline-ai-toolbar">
                            <button
                                className="sb-doc-inline-btn"
                                title="Ask AI to expand this section"
                                onClick={() => handlePromptForSection(section, 'Expand with more specific details and contextual depth')}
                            >
                                <IconWand size={10} />
                                <span>Expand</span>
                            </button>
                            <button
                                className="sb-doc-inline-btn"
                                title="Ask AI to summarize or refine"
                                onClick={() => handlePromptForSection(section, 'Refine and make more concise')}
                            >
                                <IconSparkles size={10} />
                                <span>Polish</span>
                            </button>
                            <button
                                className="sb-doc-inline-btn"
                                title="Convert into table/list"
                                onClick={() => handlePromptForSection(section, 'Convert into a structured comparison table')}
                            >
                                <IconTable size={10} />
                                <span>Table</span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="sb-primitive-document" onMouseUp={handleTextSelection}>
            {/* Floating Selection AI Quick-Action Popover */}
            {selectionCoords && selectedText && (
                <div
                    className="sb-floating-selection-popover animate-popover"
                    style={{
                        position: 'fixed',
                        top: `${selectionCoords.top}px`,
                        left: `${selectionCoords.left}px`,
                        transform: 'translateX(-50%)',
                        zIndex: 200
                    }}
                >
                    <button
                        type="button"
                        className="sb-selection-popover-pill"
                        onClick={() => handleSelectionAction('Refine and rewrite more professionally')}
                        title="Refine selected excerpt"
                    >
                        <IconWand size={12} strokeWidth={1.8} />
                        <span>Refine</span>
                    </button>
                    <button
                        type="button"
                        className="sb-selection-popover-pill"
                        onClick={() => handleSelectionAction('Expand with deeper details and multi-modal context')}
                        title="Expand selected excerpt"
                    >
                        <IconSparkles size={12} strokeWidth={1.8} />
                        <span>Expand</span>
                    </button>
                    <button
                        type="button"
                        className="sb-selection-popover-pill"
                        onClick={handleSelectionToTable}
                        title="Format selected text as Markdown table with inline diff preview"
                    >
                        <IconTable size={12} strokeWidth={1.8} />
                        <span>To Table</span>
                    </button>
                    <button
                        type="button"
                        className="sb-selection-popover-pill"
                        onClick={handleSelectionToChecklist}
                        title="Convert selected excerpt into checklist with inline diff preview"
                    >
                        <IconChecklist size={12} strokeWidth={1.8} />
                        <span>To Checklist</span>
                    </button>
                    <button
                        type="button"
                        className="sb-selection-popover-pill"
                        onClick={handleSelectionToAiCallout}
                        title="Wrap selected excerpt into a Collapsible AI Callout"
                    >
                        <IconCallout size={12} strokeWidth={1.8} />
                        <span>AI Callout</span>
                    </button>
                </div>
            )}

            {/* Document Action Strip & Toast */}
            {exportToast && (
                <div className="sb-floating-pill animate-fadeIn" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, background: '#10b981', color: '#fff', padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
                    <span>{exportToast}</span>
                </div>
            )}

            {/* Real-time Document Synthesizing Badge Banner */}
            {isStreaming && (
                <div className="sb-doc-streaming-bar animate-fadeIn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', marginBottom: '14px', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.22)' }}>
                    <div className="sb-doc-streaming-badge">
                        <span className="sb-doc-streaming-dot" />
                        <span>{streamingBadgeText || '✨ Synthesizing Multi-Modal Document in Real-time...'}</span>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--sb-cadence-medium, #8e8e93)', fontFamily: 'monospace' }}>Live 60fps stream</span>
                </div>
            )}

            {!readOnly && (
                <div className="sb-doc-toolbar-actions">
                    <div className="sb-doc-toolbar-actions-left">
                        {/* Insert media group */}
                        <div className="sb-doc-btn-group" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(255, 255, 255, 0.03)', padding: '2px 6px', borderRadius: '7px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                            <span style={{ fontSize: '10px', color: 'var(--sb-text-tertiary, #94a3b8)', fontWeight: 600, padding: '0 4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Insert</span>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={() => handleAddSection(doc.sections?.length || 0, 'editorial-image')}
                                title="Insert Clean Editorial Image (Nano Banana)"
                            >
                                <IconImage size={12} />
                                <span>Image</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={() => handleAddSection(doc.sections?.length || 0, 'svg-diagram')}
                                title="Insert Interactive Diagram"
                            >
                                <IconDiagram size={12} />
                                <span>Diagram</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={() => handleAddSection(doc.sections?.length || 0, 'video')}
                                title="Insert Video Walkthrough"
                            >
                                <IconVideo size={12} />
                                <span>Video</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={() => handleAddSection(doc.sections?.length || 0, 'location-image')}
                                title="Insert Location Image / Map"
                            >
                                <IconPin size={12} />
                                <span>Map</span>
                            </button>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={() => handleAddSection(doc.sections?.length || 0, 'citation')}
                                title="Insert Citations"
                            >
                                <IconCitation size={12} />
                                <span>Citation</span>
                            </button>
                        </div>

                        {/* Transform & workflow group */}
                        <div className="sb-doc-btn-group" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: 'rgba(255, 255, 255, 0.03)', padding: '2px 6px', borderRadius: '7px', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                            <span style={{ fontSize: '10px', color: 'var(--sb-text-tertiary, #94a3b8)', fontWeight: 600, padding: '0 4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Transform</span>
                            <button
                                type="button"
                                className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                onClick={handleAutoLinkNotes}
                                title="Scan document and automatically create [[wikilinks]] for known concepts and headings"
                            >
                                <IconSparkles size={12} />
                                <span>Auto-Link</span>
                            </button>
                            {onMorphToKanban && (
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                    onClick={handleMorphDocumentToKanban}
                                    title="Morph document tasks & milestones into an interactive Kanban Board"
                                >
                                    <IconKanban size={12} />
                                    <span>Morph to Kanban</span>
                                </button>
                            )}
                            {onMorphToNodeGraph && (
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-ghost sb-btn-xs sb-doc-action-btn"
                                    onClick={handleMorphDocumentToNodeGraph}
                                    title="Morph document architecture & flow into a Node Graph pipeline"
                                >
                                    <IconDiagram size={12} />
                                    <span>Morph to Graph</span>
                                </button>
                            )}
                        </div>
                    </div>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs sb-doc-export-btn"
                        onClick={handleExportMarkdown}
                        title="Export full specification as Markdown file"
                    >
                        <span>Export Markdown (.md)</span>
                    </button>
                </div>
            )}

            {/* Floating Table of Contents (TOC) for documents with 3+ headings */}
            {headingSections.length >= 3 && (
                <div className="sb-doc-toc-floating-container">
                    <button
                        type="button"
                        className={`sb-doc-toc-toggle-btn ${isTocOpen ? 'sb-doc-toc-toggle-active' : ''}`}
                        onClick={() => setIsTocOpen(!isTocOpen)}
                        title="Toggle Table of Contents"
                    >
                        <IconDiagram size={13} />
                        <span>Contents ({headingSections.length})</span>
                    </button>

                    {isTocOpen && (
                        <div className="sb-doc-toc-popover animate-fadeIn">
                            <div className="sb-doc-toc-header">
                                <span className="sb-doc-toc-title">Table of Contents</span>
                                <button
                                    type="button"
                                    className="sb-doc-toc-close"
                                    onClick={() => setIsTocOpen(false)}
                                    title="Close TOC"
                                >
                                    <IconClose size={12} />
                                </button>
                            </div>
                            <div className="sb-doc-toc-list">
                                {headingSections.map(h => (
                                    <button
                                        key={h.id}
                                        type="button"
                                        className={`sb-doc-toc-item sb-doc-toc-level-${h.level || 1}`}
                                        onClick={() => {
                                            const el = document.getElementById(`doc-sec-${h.id}`);
                                            if (el) {
                                                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                            }
                                        }}
                                    >
                                        <span className="sb-doc-toc-item-text">{h.content}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Document Meta Header (In-Place Editable) */}
            <div className="sb-doc-header">
                {isEditingTitle ? (
                    <input
                        autoFocus
                        className="sb-doc-main-title-input"
                        value={doc.title}
                        onChange={e => updateAndNotify({ ...doc, title: e.target.value })}
                        onBlur={() => setIsEditingTitle(false)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === 'Escape') setIsEditingTitle(false);
                        }}
                        placeholder="Document Title..."
                    />
                ) : (
                    <div
                        className="sb-doc-title-editable"
                        onClick={() => { if (!readOnly) setIsEditingTitle(true); }}
                        title={readOnly ? undefined : "Click to edit document title"}
                    >
                        <h1 className="sb-doc-main-title">{doc.title}</h1>
                        {!readOnly && <span className="sb-doc-title-edit-hint"><IconEdit size={14} /></span>}
                    </div>
                )}

                {isEditingSubtitle ? (
                    <input
                        autoFocus
                        className="sb-doc-subtitle-input"
                        value={doc.subtitle || ''}
                        onChange={e => updateAndNotify({ ...doc, subtitle: e.target.value })}
                        onBlur={() => setIsEditingSubtitle(false)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === 'Escape') setIsEditingSubtitle(false);
                        }}
                        placeholder="Document Subtitle or description..."
                    />
                ) : (
                    <div
                        className="sb-doc-subtitle-editable"
                        onClick={() => { if (!readOnly) setIsEditingSubtitle(true); }}
                        title={readOnly ? undefined : "Click to edit subtitle"}
                    >
                        <p className="sb-doc-subtitle">{doc.subtitle || ''}</p>
                        {!readOnly && !doc.subtitle && <span className="sb-doc-subtitle-add-hint">Add subtitle</span>}
                        {!readOnly && doc.subtitle && <span className="sb-doc-subtitle-edit-hint"><IconEdit size={12} /></span>}
                    </div>
                )}

                <div className="sb-doc-meta-bar">
                    {doc.author && (
                        <span className="sb-doc-meta-item">
                            <span className="sb-doc-meta-label">BY</span> <span className="sb-meta-val">{doc.author}</span>
                        </span>
                    )}
                    {doc.lastUpdated && (
                        <span className="sb-doc-meta-item">
                            <span className="sb-doc-meta-label">Updated</span> <span className="sb-meta-val">{doc.lastUpdated}</span>
                        </span>
                    )}
                </div>
            </div>

            {/* Rendered Document Sections with Inserters */}
            <div className="sb-doc-sections-container">
                {renderInserter(0)}

                {doc.sections.map((section, idx) => (
                    <React.Fragment key={section.id}>
                        {renderSection(section, idx)}
                        {renderInserter(idx + 1)}
                    </React.Fragment>
                ))}
            </div>

            {/* Full-Screen Lightbox Zoom Modal */}
            {lightboxImage && (
                <div
                    className="sb-editorial-lightbox-backdrop animate-fadeIn"
                    onClick={() => setLightboxImage(null)}
                >
                    <div className="sb-editorial-lightbox-modal" onClick={e => e.stopPropagation()}>
                        <button
                            type="button"
                            className="sb-btn sb-lightbox-close-btn"
                            onClick={() => setLightboxImage(null)}
                            title="Close Lightbox (Esc)"
                        >
                            <IconClose size={16} />
                        </button>
                        <div className="sb-lightbox-image-container">
                            <img
                                src={lightboxImage.url}
                                alt={lightboxImage.title || 'Enlarged Editorial Image'}
                                className="sb-lightbox-image"
                            />
                        </div>
                        <div className="sb-lightbox-caption-bar">
                            <div className="sb-lightbox-info-left">
                                <div className="sb-lightbox-header-line">
                                    <h3 className="sb-lightbox-title">{lightboxImage.title || 'Editorial Image'}</h3>
                                    {lightboxImage.stylePreset && (
                                        <span className="sb-lightbox-style-badge">{lightboxImage.stylePreset}</span>
                                    )}
                                    {lightboxImage.dateTag && (
                                        <span className="sb-lightbox-date-badge">{lightboxImage.dateTag}</span>
                                    )}
                                </div>
                                {lightboxImage.caption && (
                                    <p className="sb-lightbox-caption">{lightboxImage.caption}</p>
                                )}
                                {lightboxImage.prompt && (
                                    <div className="sb-lightbox-prompt-box">
                                        <div className="sb-lightbox-prompt-label">
                                            <span>✨ Nano Banana Prompt</span>
                                            <button
                                                type="button"
                                                className="sb-btn sb-prompt-copy-btn"
                                                onClick={(e) => handleCopyPrompt('lightbox', lightboxImage.prompt || '', e)}
                                                title="Copy prompt"
                                            >
                                                {copiedPromptSectionId === 'lightbox' ? (
                                                    <>
                                                        <IconCheck size={12} />
                                                        <span>Copied</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <IconCopy size={12} />
                                                        <span>Copy</span>
                                                    </>
                                                )}
                                            </button>
                                        </div>
                                        <div className="sb-lightbox-prompt-text">{lightboxImage.prompt}</div>
                                    </div>
                                )}
                            </div>
                            {lightboxImage.attribution && (
                                <span className="sb-lightbox-attribution">{lightboxImage.attribution}</span>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
