/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    ArtifactData,
    CanvasArtifact,
    ChecklistData,
    InteractiveFormData,
    KanbanBoardData,
    MarkdownDocumentData,
    MarkdownSection,
    McpHubData,
    MetricDashboardData,
    MindMapData,
    NodeGraphData,
    PrimitiveType,
    SkillsManagerData,
    LiveCodeSandboxData,
    InteractiveBrowserData,
    VideoTimelineData,
    getActiveUserName
} from '../canvas-types';
import { ChecklistPrimitive } from './ChecklistPrimitive';
import { InteractiveFormPrimitive } from './InteractiveFormPrimitive';
import { KanbanBoardPrimitive } from './KanbanBoardPrimitive';
import { MarkdownDocumentPrimitive } from './MarkdownDocumentPrimitive';
import { McpHubPrimitive } from './McpHubPrimitive';
import { MetricCardsPrimitive } from './MetricCardsPrimitive';
import { MindMapPrimitive } from './MindMapPrimitive';
import { NodeGraphPrimitive } from './NodeGraphPrimitive';
import { SkillsManagerPrimitive } from './SkillsManagerPrimitive';
import { LiveCodeSandboxPrimitive } from './LiveCodeSandboxPrimitive';
import { InteractiveBrowserPrimitive } from './InteractiveBrowserPrimitive';
import { VideoTimelinePrimitive } from './VideoTimelinePrimitive';
import { WorkspaceConfigClient } from '../workspace-config-client';
import {
    getPrimitiveSvgIcon,
    IconCheck,
    IconChecklist,
    IconClose,
    IconCode,
    IconCopy,
    IconDiff,
    IconDownload,
    IconFileText,
    IconFolder,
    IconFork,
    IconKanban,
    IconMaximize,
    IconMetrics,
    IconMinimize,
    IconNodeGraph,
    IconPlus,
    IconSparkles,
    IconTransform,
    IconWand
} from '../canvas-icons';

export interface ArtifactContainerProps {
    artifact: CanvasArtifact;
    allVersions?: CanvasArtifact[];
    historyList?: CanvasArtifact[];
    onSelectArtifact?: (artifact: CanvasArtifact) => void;
    onNewCanvas?: () => void;
    onUpdateArtifact?: (updatedArtifact: CanvasArtifact) => void;
    onSelectVersion?: (versionArtifact: CanvasArtifact) => void;
    onRollbackToVersion?: (versionArtifact: CanvasArtifact) => void;
    onForkArtifact?: (forkedArtifact: CanvasArtifact) => void;
    onClose?: () => void;
    onPromptAction?: (promptText: string) => void;
    onOpenInBrowser?: (url: string, title?: string) => void;
}

export const ArtifactContainer: React.FC<ArtifactContainerProps> = ({
    artifact,
    allVersions = [],
    onNewCanvas,
    onUpdateArtifact,
    onSelectVersion,
    onRollbackToVersion,
    onForkArtifact,
    onClose,
    onPromptAction,
    onOpenInBrowser
}) => {
    const [viewMode, setViewMode] = React.useState<'visual' | 'diff' | 'code'>('visual');
    const [copied, setCopied] = React.useState<boolean>(false);
    const [isExpanded, setIsExpanded] = React.useState<boolean>(false);
    const [showTransformMenu, setShowTransformMenu] = React.useState<boolean>(false);
    const [showExportMenu, setShowExportMenu] = React.useState<boolean>(false);
    const [diffFilter, setDiffFilter] = React.useState<'all' | 'changes-only'>('all');
    const [isSyncing, setIsSyncing] = React.useState<boolean>(false);
    const [syncFeedback, setSyncFeedback] = React.useState<string | undefined>(undefined);

    const handleSyncToWorkspace = async () => {
        setIsSyncing(true);
        const res = await WorkspaceConfigClient.getInstance().syncArtifactToWorkspace(artifact);
        setIsSyncing(false);
        if (res.success) {
            setSyncFeedback(`Saved to ${res.targetPath.split('/').pop() || 'workspace'}`);
            setTimeout(() => setSyncFeedback(undefined), 3500);
        } else {
            setSyncFeedback(res.error || 'Failed to sync');
            setTimeout(() => setSyncFeedback(undefined), 3500);
        }
    };

    const versionsList = allVersions.length > 0 ? allVersions : [artifact];
    const currentVersionIndex = versionsList.findIndex(v => (v.version || 1) === (artifact.version || 1));
    const activeIndex = currentVersionIndex >= 0 ? currentVersionIndex : versionsList.length - 1;
    const isLatestVersion = activeIndex === versionsList.length - 1;

    // Previous version for diff computation
    const previousVersion = activeIndex > 0 ? versionsList[activeIndex - 1] : undefined;

    const handlePrevVersion = () => {
        if (activeIndex > 0 && onSelectVersion) {
            onSelectVersion(versionsList[activeIndex - 1]);
        }
    };

    const handleNextVersion = () => {
        if (activeIndex < versionsList.length - 1 && onSelectVersion) {
            onSelectVersion(versionsList[activeIndex + 1]);
        }
    };

    const handleRollback = () => {
        if (onRollbackToVersion) {
            onRollbackToVersion(artifact);
        }
    };

    const handleFork = () => {
        const forkedArtifact: CanvasArtifact = {
            ...artifact,
            id: `art-fork-${Date.now()}`,
            title: `${artifact.title} (Fork)`,
            summary: `Forked variation of ${artifact.title}`,
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: JSON.parse(JSON.stringify(artifact.data))
        };

        if (onForkArtifact) {
            onForkArtifact(forkedArtifact);
        } else if (onUpdateArtifact) {
            onUpdateArtifact(forkedArtifact);
        }
    };

    const handleCopy = () => {
        const payload = JSON.stringify(artifact.data, undefined, 2);
        navigator.clipboard.writeText(payload);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // =========================================================================
    // Multi-Format Export Suite (Markdown, HTML, JSON, SVG Snapshot)
    // =========================================================================

    const downloadFile = (content: string, filename: string, mimeType: string) => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setShowExportMenu(false);
    };

    const handleExportJSON = () => {
        const payload = JSON.stringify(artifact, undefined, 2);
        const filename = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v${artifact.version || 1}.json`;
        downloadFile(payload, filename, 'application/json');
    };

    const handleExportMarkdown = () => {
        const filename = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
        let md = `# ${artifact.title}\n\n`;

        if (artifact.summary) {
            md += `> ${artifact.summary}\n\n`;
        }

        const data: any = artifact.data;
        if (normType === 'markdown-document') {
            const doc = data as MarkdownDocumentData;
            if (doc.subtitle) md += `*${doc.subtitle}*\n\n`;
            if (doc.author || doc.lastUpdated) {
                md += `**Author:** ${doc.author || getActiveUserName()} | **Updated:** ${doc.lastUpdated || 'Recently'}\n\n---\n\n`;
            }
            if (doc.sections) {
                doc.sections.forEach(sec => {
                    if (sec.type === 'heading') {
                        const hashes = '#'.repeat(sec.level || 2);
                        md += `${hashes} ${sec.content}\n\n`;
                    } else if (sec.type === 'paragraph') {
                        md += `${sec.content}\n\n`;
                    } else if (sec.type === 'callout') {
                        md += `> **${sec.calloutTitle || 'Note'}**\n> ${sec.content}\n\n`;
                    } else if (sec.type === 'quote') {
                        md += `> "${sec.content}"\n\n`;
                    } else if (sec.type === 'table' && sec.tableHeaders && sec.tableRows) {
                        md += `| ${sec.tableHeaders.join(' | ')} |\n`;
                        md += `| ${sec.tableHeaders.map(() => '---').join(' | ')} |\n`;
                        sec.tableRows.forEach(row => {
                            md += `| ${row.join(' | ')} |\n`;
                        });
                        md += '\n';
                    } else if (sec.type === 'checklist' && sec.checklistItems) {
                        sec.checklistItems.forEach(item => {
                            md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
                        });
                        md += '\n';
                    } else if (sec.type === 'code') {
                        md += `\`\`\`typescript\n${sec.content}\n\`\`\`\n\n`;
                    } else if (sec.type === 'badge-grid' && sec.badgeItems) {
                        sec.badgeItems.forEach(b => {
                            md += `- **${b.label}:** ${b.value}\n`;
                        });
                        md += '\n';
                    }
                });
            }
        } else if (normType === 'metric-dashboard') {
            const dash = data as MetricDashboardData;
            if (dash.subtitle) md += `*${dash.subtitle}*\n\n`;
            md += `## Key Metrics Summary\n\n`;
            md += `| Metric | Value | Change | Trend |\n| --- | --- | --- | --- |\n`;
            (dash.metrics || []).forEach(m => {
                md += `| ${m.label} | ${m.value} | ${m.change || '-'} | ${m.trend || '-'} |\n`;
            });
            md += '\n';
            if (dash.insights && dash.insights.length > 0) {
                md += `## Automated Insights\n\n`;
                dash.insights.forEach(ins => {
                    md += `- ${ins}\n`;
                });
                md += '\n';
            }
        } else if (normType === 'checklist') {
            const chk = data as ChecklistData;
            if (chk.description) md += `*${chk.description}*\n\n`;
            (chk.categories || []).forEach(cat => {
                md += `### ${cat.title}\n\n`;
                (cat.items || []).forEach(item => {
                    md += `- [${item.completed ? 'x' : ' '}] ${item.label} ${item.dueDate ? `*(Due: ${item.dueDate})*` : ''}\n`;
                });
                md += '\n';
            });
        } else if (normType === 'kanban-board') {
            const kan = data as KanbanBoardData;
            (kan.columns || []).forEach(col => {
                md += `### ${col.title}\n\n`;
                (col.cards || []).forEach(card => {
                    md += `- **${card.title}** ${card.priority ? `\`[${card.priority.toUpperCase()}]\`` : ''}\n`;
                    if (card.description) md += `  - ${card.description}\n`;
                    if (card.assignee) md += `  - *Assignee:* ${card.assignee}\n`;
                });
                md += '\n';
            });
        } else {
            md += `\`\`\`json\n${JSON.stringify(artifact.data, undefined, 2)}\n\`\`\`\n`;
        }

        downloadFile(md, filename, 'text/markdown');
    };

    const handleExportHTML = () => {
        const filename = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
        const dataJson = JSON.stringify(artifact.data, undefined, 2);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${artifact.title} — Scratchbox Canvas</title>
  <style>
    :root {
      --bg: #0c0d12;
      --surface: #181b24;
      --border: rgba(255, 255, 255, 0.08);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --blue: #2563eb;
      --emerald: #10b981;
      --purple: #8b5cf6;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 40px 20px;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 860px;
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 36px 44px;
      box-shadow: 0 20px 48px rgba(0,0,0,0.5);
    }
    .header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
      margin-bottom: 28px;
    }
    .tag {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(37, 99, 235, 0.15);
      color: var(--blue);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 12px;
    }
    h1 { font-size: 28px; margin: 0 0 8px 0; font-weight: 700; }
    p.subtitle { color: var(--text-muted); font-size: 15px; margin: 0; line-height: 1.5; }
    .content { line-height: 1.65; font-size: 15px; }
    .callout {
      background: rgba(139, 92, 246, 0.1);
      border-left: 4px solid var(--purple);
      padding: 16px 20px;
      border-radius: 8px;
      margin: 20px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 10px 14px;
      text-align: left;
    }
    th { background: rgba(255, 255, 255, 0.04); font-size: 13px; }
    pre {
      background: #0a0c10;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      overflow-x: auto;
      color: #38bdf8;
      font-family: monospace;
      font-size: 13px;
    }
    .footer {
      margin-top: 40px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="tag">${artifact.type}</span>
      <h1>${artifact.title}</h1>
      <p class="subtitle">${artifact.summary || ''}</p>
    </div>
    <div class="content">
      <pre><code>${dataJson.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
    </div>
    <div class="footer">
      <span>Exported from Scratchbox Studio (v${artifact.version || 1})</span>
      <span>${new Date().toLocaleDateString()}</span>
    </div>
  </div>
</body>
</html>`;

        downloadFile(html, filename, 'text/html');
    };

    const handleExportSVG = () => {
        const filename = `${artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
        const width = 800;
        const height = 480;

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0c0d12"/>
      <stop offset="100%" stop-color="#181b24"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e2230"/>
      <stop offset="100%" stop-color="#13161f"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="16" fill="url(#cardGrad)" stroke="rgba(255,255,255,0.1)" stroke-width="1.5"/>
  
  <rect x="48" y="48" width="90" height="24" rx="12" fill="rgba(37, 99, 235, 0.2)" stroke="#2563eb" stroke-width="1"/>
  <text x="93" y="64" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="700" fill="#60a5fa" text-anchor="middle">${artifact.type.toUpperCase()}</text>
  
  <text x="48" y="110" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="24" font-weight="700" fill="#f8fafc">${artifact.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
  <text x="48" y="136" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="14" fill="#94a3b8">${(artifact.summary || 'Scratchbox Visual Canvas Artifact').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>
  
  <line x1="48" y1="160" x2="${width - 48}" y2="160" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  
  <!-- Canvas stylized body preview -->
  <rect x="48" y="184" width="220" height="110" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)"/>
  <text x="68" y="214" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" font-weight="600" fill="#94a3b8">Version</text>
  <text x="68" y="248" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="28" font-weight="700" fill="#38bdf8">v${artifact.version || 1}</text>
  
  <rect x="290" y="184" width="462" height="220" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)"/>
  <text x="314" y="214" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="600" fill="#f8fafc">Visual Canvas Preview</text>
  <text x="314" y="242" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="#94a3b8">Type: ${artifact.type}</text>
  <text x="314" y="266" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="#94a3b8">Revisions Recorded: ${versionsList.length}</text>
  <text x="314" y="290" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" fill="#94a3b8">Status: Interactive Liquid Glass Primitive</text>
  
  <text x="48" y="${height - 40}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" fill="#64748b">Scratchbox IDE Studio • Liquid Glass Canvas</text>
  <text x="${width - 48}" y="${height - 40}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="11" fill="#64748b" text-anchor="end">${new Date().toLocaleDateString()}</text>
</svg>`;

        downloadFile(svg, filename, 'image/svg+xml');
    };

    const handlePrimitiveUpdate = (updatedData: ArtifactData) => {
        if (onUpdateArtifact) {
            onUpdateArtifact({
                ...artifact,
                data: updatedData,
                version: (artifact.version || 1) + 1
            });
        }
    };

    const getPrimitiveBadgeInfo = (type: PrimitiveType) => {
        switch (type) {
            case 'metric-dashboard':
                return { label: 'Metrics', color: 'emerald' };
            case 'kanban-board':
                return { label: 'Kanban', color: 'indigo' };
            case 'interactive-form':
                return { label: 'Form', color: 'blue' };
            case 'node-graph':
                return { label: 'Flow Graph', color: 'purple' };
            case 'markdown-document':
                return { label: 'Document', color: 'cyan' };
            case 'checklist':
                return { label: 'Checklist', color: 'amber' };
            case 'mind-map':
                return { label: 'Mind Map', color: 'rose' };
            case 'skills-hub':
                return { label: 'Superpowers', color: 'purple' };
            case 'mcp-hub':
                return { label: 'MCP Tools', color: 'indigo' };
            case 'live-code-sandbox':
                return { label: 'Live Sandbox', color: 'blue' };
            case 'interactive-browser':
            case 'browser':
                return { label: 'Web Browser', color: 'cyan' };
            case 'video-timeline':
                return { label: 'Video NLE', color: 'pink' };
            default:
                return { label: 'Canvas', color: 'blue' };
        }
    };

    const normalizeType = (t: string): PrimitiveType => {
        if (t === 'rendered-document' || t === 'document') return 'markdown-document';
        if (t === 'flow-graph' || t === 'graph') return 'node-graph';
        if (t === 'metrics' || t === 'dashboard') return 'metric-dashboard';
        if (t === 'kanban') return 'kanban-board';
        if (t === 'form') return 'interactive-form';
        if (t === 'action-checklist') return 'checklist';
        if (t === 'skills-manager') return 'skills-hub';
        if (t === 'sandbox' || t === 'code-sandbox') return 'live-code-sandbox';
        if (t === 'browser' || t === 'web-browser') return 'interactive-browser';
        if (t === 'video-timeline' || t === 'video' || t === 'nle') return 'video-timeline';
        return (t as PrimitiveType) || 'markdown-document';
    };

    const normType = normalizeType(artifact.type);
    const badge = getPrimitiveBadgeInfo(normType);

    // =========================================================================
    // Visual Version Diff & Revision Comparison View
    // =========================================================================

    const renderDiffView = () => {
        if (!previousVersion) {
            return (
                <div className="sb-diff-container sb-diff-single-version animate-fadeIn">
                    <div className="sb-diff-empty-hero">
                        <div className="sb-diff-hero-icon">
                            <IconDiff size={28} strokeWidth={1.5} />
                        </div>
                        <h3 className="sb-diff-empty-title">Initial Revision (v{artifact.version || 1})</h3>
                        <p className="sb-diff-empty-desc">
                            This is the initial version of <strong>{artifact.title}</strong>. As you edit, refine, or polish sections, new revision snapshots are saved automatically so you can compare exact visual diffs here!
                        </p>
                        <div className="sb-diff-hint-actions">
                            <button
                                type="button"
                                className="sb-btn sb-btn-primary sb-btn-sm"
                                onClick={() => setViewMode('visual')}
                            >
                                Return to Canvas Editor
                            </button>
                        </div>
                    </div>
                </div>
            );
        }

        // Compute structured section diffs for markdown documents or generic primitives
        const currentDoc = artifact.data as MarkdownDocumentData;
        const prevDoc = previousVersion.data as MarkdownDocumentData;

        const currentSections = currentDoc?.sections || [];
        const prevSections = prevDoc?.sections || [];

        const prevSectionMap = new Map<string, MarkdownSection>();
        prevSections.forEach(s => prevSectionMap.set(s.id, s));

        const currentSectionMap = new Map<string, MarkdownSection>();
        currentSections.forEach(s => currentSectionMap.set(s.id, s));

        interface SectionDiffItem {
            id: string;
            status: 'added' | 'modified' | 'removed' | 'unchanged';
            current?: MarkdownSection;
            previous?: MarkdownSection;
            diffSummary?: string;
        }

        const diffItems: SectionDiffItem[] = [];

        // Check current sections against previous
        currentSections.forEach(sec => {
            const prev = prevSectionMap.get(sec.id);
            if (!prev) {
                diffItems.push({
                    id: sec.id,
                    status: 'added',
                    current: sec,
                    diffSummary: 'New section created in this revision'
                });
            } else {
                const isContentDiff = (sec.content || '') !== (prev.content || '');
                const isTitleDiff = (sec.calloutTitle || '') !== (prev.calloutTitle || '');
                const isTableDiff = JSON.stringify(sec.tableRows || []) !== JSON.stringify(prev.tableRows || []);
                const isChecklistDiff = JSON.stringify(sec.checklistItems || []) !== JSON.stringify(prev.checklistItems || []);

                if (isContentDiff || isTitleDiff || isTableDiff || isChecklistDiff) {
                    diffItems.push({
                        id: sec.id,
                        status: 'modified',
                        current: sec,
                        previous: prev,
                        diffSummary: 'Content modified in this revision'
                    });
                } else {
                    diffItems.push({
                        id: sec.id,
                        status: 'unchanged',
                        current: sec,
                        previous: prev
                    });
                }
            }
        });

        // Check for removed sections
        prevSections.forEach(sec => {
            if (!currentSectionMap.has(sec.id)) {
                diffItems.push({
                    id: sec.id,
                    status: 'removed',
                    previous: sec,
                    diffSummary: 'Section removed in this revision'
                });
            }
        });

        const addedCount = diffItems.filter(d => d.status === 'added').length;
        const modifiedCount = diffItems.filter(d => d.status === 'modified').length;
        const removedCount = diffItems.filter(d => d.status === 'removed').length;

        const filteredItems = diffFilter === 'changes-only'
            ? diffItems.filter(d => d.status !== 'unchanged')
            : diffItems;

        return (
            <div className="sb-diff-container animate-fadeIn">
                {/* Diff Header Bar */}
                <div className="sb-diff-summary-bar">
                    <div className="sb-diff-summary-left">
                        <div className="sb-diff-badge-group">
                            <span className="sb-diff-badge sb-badge-ver-from">v{previousVersion.version || activeIndex}</span>
                            <span className="sb-diff-arrow">→</span>
                            <span className="sb-diff-badge sb-badge-ver-to">v{artifact.version || activeIndex + 1}</span>
                        </div>
                        <span className="sb-diff-meta-text">
                            Revision Comparison ({artifact.title})
                        </span>
                    </div>

                    <div className="sb-diff-summary-right">
                        <div className="sb-diff-stat-pills">
                            <span className="sb-diff-stat-pill sb-pill-added">
                                +{addedCount} Added
                            </span>
                            <span className="sb-diff-stat-pill sb-pill-modified">
                                ~{modifiedCount} Modified
                            </span>
                            <span className="sb-diff-stat-pill sb-pill-removed">
                                -{removedCount} Removed
                            </span>
                        </div>

                        <div className="sb-segmented-control sb-segmented-control-xs">
                            <button
                                type="button"
                                className={`sb-segment-btn ${diffFilter === 'all' ? 'sb-segment-active' : ''}`}
                                onClick={() => setDiffFilter('all')}
                            >
                                All Blocks
                            </button>
                            <button
                                type="button"
                                className={`sb-segment-btn ${diffFilter === 'changes-only' ? 'sb-segment-active' : ''}`}
                                onClick={() => setDiffFilter('changes-only')}
                            >
                                Changes Only
                            </button>
                        </div>
                    </div>
                </div>

                {/* Diff Visual Section List */}
                <div className="sb-diff-sections-list">
                    {filteredItems.length === 0 ? (
                        <div className="sb-diff-no-changes">
                            <IconCheck size={18} />
                            <span>No modified sections between these two revisions.</span>
                        </div>
                    ) : (
                        filteredItems.map(item => {
                            const isAdded = item.status === 'added';
                            const isModified = item.status === 'modified';
                            const isRemoved = item.status === 'removed';

                            return (
                                <div
                                    key={item.id}
                                    className={`sb-diff-block-card sb-diff-${item.status}`}
                                >
                                    <div className="sb-diff-block-header">
                                        <div className="sb-diff-block-status-badge">
                                            {isAdded && <span className="sb-tag-added">+ Added</span>}
                                            {isModified && <span className="sb-tag-modified">~ Modified</span>}
                                            {isRemoved && <span className="sb-tag-removed">- Removed</span>}
                                            {item.status === 'unchanged' && <span className="sb-tag-unchanged">Unchanged</span>}
                                        </div>
                                        <span className="sb-diff-block-type">
                                            {item.current?.type || item.previous?.type || 'Section'}
                                        </span>
                                    </div>

                                    {/* Diff Content Preview */}
                                    <div className="sb-diff-block-body">
                                        {isModified && item.previous && item.current && (
                                            <div className="sb-diff-side-by-side">
                                                <div className="sb-diff-pane sb-diff-pane-prev">
                                                    <span className="sb-diff-pane-label">Previous (v{previousVersion.version || activeIndex})</span>
                                                    <div className="sb-diff-content-prev">
                                                        {item.previous.content || item.previous.calloutTitle || 'Previous content'}
                                                    </div>
                                                </div>
                                                <div className="sb-diff-pane sb-diff-pane-curr">
                                                    <span className="sb-diff-pane-label">Updated (v{artifact.version || activeIndex + 1})</span>
                                                    <div className="sb-diff-content-curr">
                                                        {item.current.content || item.current.calloutTitle || 'Updated content'}
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {isAdded && item.current && (
                                            <div className="sb-diff-content-curr">
                                                <div className="sb-diff-added-glow">
                                                    {item.current.content || item.current.calloutTitle || 'Newly generated section content'}
                                                </div>
                                            </div>
                                        )}

                                        {isRemoved && item.previous && (
                                            <div className="sb-diff-content-prev sb-diff-removed-strike">
                                                {item.previous.content || item.previous.calloutTitle || 'Deleted section'}
                                            </div>
                                        )}

                                        {item.status === 'unchanged' && item.current && (
                                            <div className="sb-diff-content-unchanged">
                                                {item.current.content || item.current.calloutTitle || 'Content identical across revisions'}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        );
    };

    const renderPrimitiveContent = () => {
        if (viewMode === 'diff') {
            return renderDiffView();
        }

        if (viewMode === 'code') {
            return (
                <div className="sb-artifact-raw-view">
                    <div className="sb-raw-header">
                        <span>Raw JSON Data</span>
                        <button
                            type="button"
                            className="sb-btn sb-btn-secondary sb-btn-xs"
                            onClick={handleCopy}
                        >
                            {copied ? 'Copied' : 'Copy JSON'}
                        </button>
                    </div>
                    <pre className="sb-raw-code-block">
                        {JSON.stringify(artifact.data, undefined, 2)}
                    </pre>
                </div>
            );
        }

        switch (normType) {
            case 'metric-dashboard':
                return (
                    <MetricCardsPrimitive
                        data={artifact.data as MetricDashboardData}
                        onUpdate={handlePrimitiveUpdate}
                    />
                );
            case 'kanban-board':
                return (
                    <KanbanBoardPrimitive
                        data={artifact.data as KanbanBoardData}
                        onUpdate={handlePrimitiveUpdate}
                    />
                );
            case 'interactive-form':
                return (
                    <InteractiveFormPrimitive
                        data={artifact.data as InteractiveFormData}
                        onUpdate={handlePrimitiveUpdate}
                        onForkArtifact={onForkArtifact}
                        onPromptAction={onPromptAction}
                        onSubmit={submitted => {
                            if (onPromptAction) {
                                onPromptAction(`Form "${artifact.title}" submitted with data: ${JSON.stringify(submitted)}`);
                            }
                        }}
                    />
                );
            case 'node-graph':
                return (
                    <NodeGraphPrimitive
                        data={artifact.data as NodeGraphData}
                        onUpdate={handlePrimitiveUpdate}
                        onPromptAction={onPromptAction}
                    />
                );
            case 'markdown-document':
                return (
                    <MarkdownDocumentPrimitive
                        data={artifact.data as MarkdownDocumentData}
                        onUpdate={handlePrimitiveUpdate}
                        onPromptAction={onPromptAction}
                        onOpenInBrowser={onOpenInBrowser}
                    />
                );
            case 'checklist':
                return (
                    <ChecklistPrimitive
                        data={artifact.data as ChecklistData}
                        onUpdate={handlePrimitiveUpdate}
                    />
                );
            case 'mind-map':
                return (
                    <MindMapPrimitive
                        data={artifact.data as MindMapData}
                        onUpdate={handlePrimitiveUpdate}
                    />
                );
            case 'skills-hub':
                return (
                    <SkillsManagerPrimitive
                        skills={(artifact.data as SkillsManagerData)?.skills || []}
                        onSkillsChange={updatedSkills => {
                            handlePrimitiveUpdate({
                                ...(artifact.data as SkillsManagerData),
                                skills: updatedSkills
                            });
                        }}
                        onSelectPromptStarter={starter => {
                            if (onPromptAction) onPromptAction(starter);
                        }}
                    />
                );
            case 'mcp-hub':
                return (
                    <McpHubPrimitive
                        servers={(artifact.data as McpHubData)?.servers || []}
                        recentExecutions={(artifact.data as McpHubData)?.recentExecutions || []}
                        onServersChange={updatedServers => {
                            handlePrimitiveUpdate({
                                ...(artifact.data as McpHubData),
                                servers: updatedServers
                            });
                        }}
                        onRunToolAction={server => {
                            if (onPromptAction) onPromptAction(`Run live check on ${server.name}`);
                        }}
                    />
                );
            case 'live-code-sandbox':
                return (
                    <LiveCodeSandboxPrimitive
                        data={artifact.data as LiveCodeSandboxData}
                        onUpdate={handlePrimitiveUpdate}
                        onForkArtifact={onForkArtifact}
                        onPromptAction={onPromptAction}
                    />
                );
            case 'interactive-browser':
                return (
                    <InteractiveBrowserPrimitive
                        data={artifact.data as InteractiveBrowserData}
                        onUpdate={handlePrimitiveUpdate}
                        onPromptAction={onPromptAction}
                    />
                );
            case 'video-timeline':
                return (
                    <VideoTimelinePrimitive
                        data={artifact.data as VideoTimelineData}
                        onUpdate={handlePrimitiveUpdate}
                        onPromptAction={onPromptAction}
                    />
                );
            default:
                return (
                    <MarkdownDocumentPrimitive
                        data={{
                            title: artifact.title,
                            sections: [{
                                id: 'sec-fallback',
                                type: 'paragraph',
                                content: typeof artifact.data === 'string' ? artifact.data : JSON.stringify(artifact.data, undefined, 2)
                            }]
                        }}
                        onUpdate={handlePrimitiveUpdate}
                        onPromptAction={onPromptAction}
                        onOpenInBrowser={onOpenInBrowser}
                    />
                );
        }
    };

    return (
        <div className={`sb-artifact-container ${isExpanded ? 'sb-artifact-expanded' : ''}`}>
            {/* Unified ChatGPT Canvas Header Bar */}
            <div className="sb-artifact-topbar">
                {/* Left: Minimal Monochrome SVG Icon + Document Title + Fork Button */}
                <div className="sb-artifact-meta">
                    <div className="sb-artifact-meta-icon" title={badge.label}>
                        {getPrimitiveSvgIcon(normType, 15, 1.8)}
                    </div>
                    <h2 className="sb-artifact-title" title={artifact.title}>{artifact.title}</h2>

                    {/* Canvas Forking & Branching Action Button */}
                    <button
                        type="button"
                        className="sb-btn-fork-canvas"
                        onClick={handleFork}
                        title="Fork canvas into a parallel exploratory branch"
                    >
                        <IconFork size={12} strokeWidth={2} />
                        <span>Fork</span>
                    </button>

                    {onNewCanvas && (
                        <button
                            type="button"
                            className="sb-btn-fork-canvas"
                            onClick={onNewCanvas}
                            title="Create or open canvas automation workflow"
                        >
                            <IconPlus size={12} strokeWidth={2} />
                            <span>New Canvas</span>
                        </button>
                    )}
                </div>

                {/* Center: Version Stepper & Diff Toggle */}
                <div className="sb-artifact-topbar-center">
                    <div className="sb-artifact-version-stepper">
                        <button
                            type="button"
                            className="sb-ver-step-btn"
                            onClick={handlePrevVersion}
                            disabled={activeIndex <= 0}
                            title="Previous version"
                        >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </button>
                        <span className="sb-ver-badge">
                            v{artifact.version || activeIndex + 1} of {Math.max(versionsList.length, artifact.version || 1)}
                        </span>
                        <button
                            type="button"
                            className="sb-ver-step-btn"
                            onClick={handleNextVersion}
                            disabled={activeIndex >= versionsList.length - 1}
                            title="Next version"
                        >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </button>

                        {!isLatestVersion && (
                            <button
                                type="button"
                                className="sb-ver-restore-btn"
                                onClick={handleRollback}
                                title="Restore this version"
                            >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="1 4 1 10 7 10" />
                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                                </svg>
                                <span>Restore</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Right: Controls Toggle, Copy, Multi-Format Export, Fullscreen, Close */}
                <div className="sb-artifact-controls">
                    {/* Canvas / Diff / Data 3-Way Segmented Toggle */}
                    <div className="sb-segmented-control sb-segmented-control-sm">
                        <button
                            type="button"
                            className={`sb-segment-btn ${viewMode === 'visual' ? 'sb-segment-active' : ''}`}
                            onClick={() => setViewMode('visual')}
                        >
                            Canvas
                        </button>
                        <button
                            type="button"
                            className={`sb-segment-btn ${viewMode === 'diff' ? 'sb-segment-active sb-diff-segment-active' : ''}`}
                            onClick={() => setViewMode('diff')}
                            title="Visual Version Diff & Revision Comparison"
                        >
                            <IconDiff size={11} />
                            <span>Changes</span>
                        </button>
                        <button
                            type="button"
                            className={`sb-segment-btn ${viewMode === 'code' ? 'sb-segment-active' : ''}`}
                            onClick={() => setViewMode('code')}
                        >
                            Data
                        </button>
                    </div>

                    {/* Sync to Workspace Button */}
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs"
                        onClick={handleSyncToWorkspace}
                        disabled={isSyncing}
                        title="Save and synchronize artifact directly to project workspace files"
                    >
                        <IconFolder size={12} />
                        <span>{isSyncing ? 'Syncing...' : (syncFeedback || 'Sync to Project')}</span>
                    </button>

                    {/* Copy Button */}
                    <button
                        type="button"
                        className="sb-icon-button"
                        onClick={handleCopy}
                        title={copied ? 'Copied to clipboard' : 'Copy JSON'}
                    >
                        {copied ? (
                            <IconCheck size={14} />
                        ) : (
                            <IconCopy size={14} />
                        )}
                    </button>

                    {/* Multi-Format Export Suite Dropdown */}
                    <div className="sb-export-dropdown-wrap">
                        <button
                            type="button"
                            className={`sb-icon-button ${showExportMenu ? 'sb-icon-active' : ''}`}
                            onClick={() => setShowExportMenu(!showExportMenu)}
                            title="Export options (Markdown, HTML, JSON, SVG)"
                        >
                            <IconDownload size={14} />
                        </button>

                        {showExportMenu && (
                            <div className="sb-export-menu-popover animate-popover" onMouseDown={e => e.stopPropagation()}>
                                <div className="sb-export-menu-header">
                                    <span>Export Suite</span>
                                </div>
                                <button
                                    type="button"
                                    className="sb-export-menu-item"
                                    onClick={() => {
                                        setShowExportMenu(false);
                                        handleSyncToWorkspace();
                                    }}
                                >
                                    <IconFolder size={13} strokeWidth={2} />
                                    <div className="sb-export-item-text">
                                        <span className="sb-export-item-title">Sync to Project Files</span>
                                        <span className="sb-export-item-sub">Save directly into workspace folder</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-export-menu-item"
                                    onClick={handleExportMarkdown}
                                >
                                    <IconFileText size={13} strokeWidth={2} />
                                    <div className="sb-export-item-text">
                                        <span className="sb-export-item-title">Markdown (.md)</span>
                                        <span className="sb-export-item-sub">Clean GitHub-flavored document</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-export-menu-item"
                                    onClick={handleExportHTML}
                                >
                                    <IconCode size={13} strokeWidth={2} />
                                    <div className="sb-export-item-text">
                                        <span className="sb-export-item-title">Interactive HTML (.html)</span>
                                        <span className="sb-export-item-sub">Standalone browser-ready artifact</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-export-menu-item"
                                    onClick={handleExportJSON}
                                >
                                    <IconDownload size={13} strokeWidth={2} />
                                    <div className="sb-export-item-text">
                                        <span className="sb-export-item-title">Artifact JSON (.json)</span>
                                        <span className="sb-export-item-sub">Complete typed structured data</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-export-menu-item"
                                    onClick={handleExportSVG}
                                >
                                    <IconTransform size={13} strokeWidth={2} />
                                    <div className="sb-export-item-text">
                                        <span className="sb-export-item-title">Vector Snapshot (.svg)</span>
                                        <span className="sb-export-item-sub">High-res canvas diagram vector</span>
                                    </div>
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Full Canvas Toggle */}
                    <button
                        type="button"
                        className="sb-icon-button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        title={isExpanded ? 'Collapse' : 'Expand full width'}
                    >
                        {isExpanded ? (
                            <IconMinimize size={14} />
                        ) : (
                            <IconMaximize size={14} />
                        )}
                    </button>

                    {/* Close / Minimize Artifact */}
                    {onClose && (
                        <button
                            type="button"
                            className="sb-icon-button sb-btn-close"
                            onClick={onClose}
                            title="Close canvas"
                        >
                            <IconClose size={13} />
                        </button>
                    )}
                </div>
            </div>

            {/* Artifact Workspace Body */}
            <div className="sb-artifact-body">
                {renderPrimitiveContent()}
            </div>

            {/* Floating ChatGPT Canvas Quick-Actions Pill (Bottom-Right) */}
            {onPromptAction && viewMode === 'visual' && (
                <div className="sb-canvas-floating-quick-bar">
                    <button
                        type="button"
                        className="sb-canvas-floating-pill"
                        onClick={() => onPromptAction(`Polish and elevate ${artifact.title} with high-clarity typography and concise insights`)}
                        title="Polish with AI"
                    >
                        <IconWand size={13} strokeWidth={1.8} />
                        <span>Polish</span>
                    </button>

                    <button
                        type="button"
                        className="sb-canvas-floating-pill"
                        onClick={() => onPromptAction(`Add more specific details, metrics, and comprehensive scope to ${artifact.title}`)}
                        title="Add depth & details"
                    >
                        <IconSparkles size={13} strokeWidth={1.8} />
                        <span>Add Detail</span>
                    </button>

                    <div className="sb-canvas-pill-dropdown-wrap">
                        <button
                            type="button"
                            className="sb-canvas-floating-pill"
                            onClick={() => setShowTransformMenu(!showTransformMenu)}
                            title="Transform to another format"
                        >
                            <IconTransform size={13} strokeWidth={1.8} />
                            <span>Transform ▾</span>
                        </button>

                        {showTransformMenu && (
                            <div className="sb-canvas-transform-dropdown animate-popover" onMouseDown={e => e.stopPropagation()}>
                                {artifact.type !== 'kanban-board' && (
                                    <button
                                        type="button"
                                        className="sb-transform-option"
                                        onClick={() => {
                                            setShowTransformMenu(false);
                                            onPromptAction(`Convert the items in "${artifact.title}" into an interactive multi-column Kanban board`);
                                        }}
                                    >
                                        <IconKanban size={13} />
                                        <span>To Kanban Board</span>
                                    </button>
                                )}

                                {artifact.type !== 'metric-dashboard' && (
                                    <button
                                        type="button"
                                        className="sb-transform-option"
                                        onClick={() => {
                                            setShowTransformMenu(false);
                                            onPromptAction(`Convert the key data in "${artifact.title}" into an executive KPI Metric Dashboard`);
                                        }}
                                    >
                                        <IconMetrics size={13} />
                                        <span>To Metric Dashboard</span>
                                    </button>
                                )}

                                {artifact.type !== 'node-graph' && (
                                    <button
                                        type="button"
                                        className="sb-transform-option"
                                        onClick={() => {
                                            setShowTransformMenu(false);
                                            onPromptAction(`Generate an interactive system flow node graph for "${artifact.title}"`);
                                        }}
                                    >
                                        <IconNodeGraph size={13} />
                                        <span>To Node Flow Graph</span>
                                    </button>
                                )}

                                {artifact.type !== 'checklist' && (
                                    <button
                                        type="button"
                                        className="sb-transform-option"
                                        onClick={() => {
                                            setShowTransformMenu(false);
                                            onPromptAction(`Convert "${artifact.title}" into an actionable step-by-step checklist`);
                                        }}
                                    >
                                        <IconChecklist size={13} />
                                        <span>To Action Checklist</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
