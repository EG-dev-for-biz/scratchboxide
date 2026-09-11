/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * useArtifactExports
 *
 * Exporting the active artifact (Markdown download, Google Docs, Google Drive) and syncing sandbox saves back into markdown documents.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { CanvasArtifact, LiveCodeSandboxData, MarkdownDocumentData, MarkdownSection, ModalType, getActiveUserName } from '../canvas-types';
import { GoogleDriveService } from '../google-drive-service';
import { useArtifactSync } from '../hooks/useArtifactSync';
import { useCanvasOpeners } from '../hooks/useCanvasOpeners';
import { ChatState } from '../state/chatStore';

export interface UseArtifactExportsDeps {
    activeArtifact: ChatState['activeArtifact'];
    artifactHistory: ChatState['artifactHistory'];
    handleOpenInAppBrowser: ReturnType<typeof useCanvasOpeners>['handleOpenInAppBrowser'];
    handleUpdateArtifact: ReturnType<typeof useArtifactSync>['handleUpdateArtifact'];
    openModal: (modal: ModalType) => void;
    showToast: (text: string, icon?: string) => void;
}

export function useArtifactExports(deps: UseArtifactExportsDeps) {
    const { activeArtifact, artifactHistory, handleOpenInAppBrowser, handleUpdateArtifact, openModal, showToast } = deps;

    const triggerMarkdownExport = React.useCallback(() => {
        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.7 Flash powers high-reasoning synthesis.' },
                { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                { id: 'sec-5', type: 'checklist', checklistItems: [
                    { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                    { id: 'c2', text: 'Structure rich document blocks & callouts', done: true },
                    { id: 'c3', text: 'Verify Kanban sprint columns and drag & drop', done: false }
                ]}
            ]
        };

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
            } else if (sec.type === 'callout') {
                md += `> **${sec.calloutTitle || 'Note'}**\n> ${sec.content}\n\n`;
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
    }, [activeArtifact]);

    const triggerGoogleDocsExport = React.useCallback(async () => {
        const driveService = GoogleDriveService.getInstance();
        const connectionState = driveService.getState();
        if (connectionState.status !== 'connected') {
            openModal('google-drive');
            return;
        }

        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' }
            ]
        };

        showToast('Exporting to Google Docs...', '📄');

        try {
            const res = await driveService.exportDocumentToGoogleDocs(doc);
            showToast(`✓ Exported to Google Docs: ${res.documentTitle}`, '✓');
            if (res.documentUrl) {
                handleOpenInAppBrowser(res.documentUrl, `Google Docs: ${res.documentTitle}`);
            }
        } catch (err: any) {
            showToast(`Export failed: ${err?.message || 'Google Drive error'}`, '⚠️');
        }
    }, [activeArtifact, openModal, showToast, handleOpenInAppBrowser]);

    const triggerGoogleDriveSave = React.useCallback(async () => {
        const driveService = GoogleDriveService.getInstance();
        const connectionState = driveService.getState();
        if (connectionState.status !== 'connected') {
            openModal('google-drive');
            return;
        }

        const doc = (activeArtifact?.type === 'markdown-document' ? (activeArtifact.data as MarkdownDocumentData) : undefined) || {
            title: 'Project Specification & Notes',
            subtitle: 'Rich block document for architecture, roadmap, and specs',
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
            sections: [
                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' }
            ]
        };

        showToast('Saving Markdown file to Google Drive...', '💾');

        try {
            const fileName = `${(doc.title || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
            let md = `# ${doc.title || 'Project Specification'}\n\n`;
            if (doc.subtitle) md += `> ${doc.subtitle}\n\n`;
            (doc.sections || []).forEach(sec => {
                if (sec.type === 'heading') md += `\n${'#'.repeat(sec.level || 1)} ${sec.content}\n\n`;
                else if (sec.type === 'paragraph') md += `${sec.content}\n\n`;
                else if (sec.type === 'callout') md += `> **${sec.calloutTitle || 'Note'}**\n> ${sec.content}\n\n`;
                else if (sec.type === 'checklist') {
                    (sec.checklistItems || []).forEach(item => {
                        md += `- [${item.done ? 'x' : ' '}] ${item.text}\n`;
                    });
                    md += '\n';
                } else if (sec.type === 'code') {
                    md += `\`\`\`${sec.codeLanguage || ''}\n${sec.content}\n\`\`\`\n\n`;
                }
            });

            const res = await driveService.saveFileToGoogleDrive(fileName, md, 'text/markdown');
            showToast(`✓ Saved to Google Drive: ${res.name}`, '✓');
            if (res.webViewLink) {
                handleOpenInAppBrowser(res.webViewLink, `Google Drive: ${res.name}`);
            }
        } catch (err: any) {
            showToast(`Save failed: ${err?.message || 'Google Drive error'}`, '⚠️');
        }
    }, [activeArtifact, openModal, showToast, handleOpenInAppBrowser]);

    const syncSandboxSaveToMarkdown = React.useCallback((sandboxData: LiveCodeSandboxData) => {
        const markdownArtifact = artifactHistory.find(art => art.type === 'markdown-document');
        if (!markdownArtifact) return;

        let hasApiSpec = false;
        let hasSecurityGuard = false;

        const filesToScan = Array.isArray(sandboxData.files) ? sandboxData.files : [];
        for (const file of filesToScan) {
            const code = (file.content || '').toLowerCase();
            if (code.includes('fetch') || code.includes('axios') || code.includes('/api/') || code.includes('app.get') || code.includes('app.post')) {
                hasApiSpec = true;
            }
            if (code.includes('auth') || code.includes('token') || code.includes('password') || code.includes('jwt') || code.includes('cors')) {
                hasSecurityGuard = true;
            }
        }

        const currentDoc = (markdownArtifact.data as MarkdownDocumentData) || { sections: [] };
        const originalSections = Array.isArray(currentDoc.sections) ? currentDoc.sections : [];
        const updatedSections = originalSections.filter(sec => 
            sec.id !== 'sec-injected-api-spec-table' && 
            sec.id !== 'sec-injected-security-guardrail-callout'
        );

        if (hasApiSpec) {
            const apiTableSection: MarkdownSection = {
                id: 'sec-injected-api-spec-table',
                type: 'table',
                content: 'Dynamic API Specifications Table',
                tableHeaders: ['Endpoint', 'Method', 'Query Params', 'Status Code', 'Description'],
                tableRows: [
                    ['/api/v1/auth/login', 'POST', 'username, password', '200 OK / 401 Unauthorized', 'User authentication and JWT token issuance.'],
                    ['/api/v1/sandbox/execute', 'POST', 'fileId, code', '200 OK / 500 Error', 'Executes sandbox code in Pyodide WASM runtime.'],
                    ['/api/v1/metrics', 'GET', 'interval, limit', '200 OK', 'Retrieve real-time resource utilization metrics.']
                ]
            };
            updatedSections.push(apiTableSection);
        }

        if (hasSecurityGuard) {
            const securityCalloutSection: MarkdownSection = {
                id: 'sec-injected-security-guardrail-callout',
                type: 'callout',
                calloutType: 'warning',
                calloutTitle: 'Security & Sandboxing Guardrails Active',
                content: 'CRITICAL: This environment executes arbitrary code inside a highly isolated WebAssembly-based Pyodide / Docker subcontainer. CORS headers are strictly locked down to project domains, and credentials (JWT/Service Accounts) must never be written inline.'
            };
            updatedSections.push(securityCalloutSection);
        }

        const updatedDocArtifact: CanvasArtifact = {
            ...markdownArtifact,
            data: {
                ...currentDoc,
                sections: updatedSections
            } as MarkdownDocumentData,
            version: (markdownArtifact.version || 1) + 1,
            createdAt: new Date().toLocaleTimeString()
        };

        handleUpdateArtifact(updatedDocArtifact);
    }, [artifactHistory, handleUpdateArtifact]);

    return { syncSandboxSaveToMarkdown, triggerGoogleDocsExport, triggerGoogleDriveSave, triggerMarkdownExport };
}
