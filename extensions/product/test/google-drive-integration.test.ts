/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownDocumentData } from '../src/browser/generative-canvas/canvas-types';
import { DEFAULT_MCP_SERVERS } from '../src/browser/generative-canvas/canvas-types';
import { GoogleDriveService } from '../src/browser/generative-canvas/google-drive-service';

async function runGoogleDriveIntegrationTests() {
    console.log('🧪 Running Google Drive & Google Docs Integration Test Suite...\n');

    // =========================================================================
    // TEST 1: Document Conversion to Google Docs Formatted Payload
    // =========================================================================
    console.log('--- 1. Testing Document to Google Docs Payload Conversion ---');
    const sampleDoc: MarkdownDocumentData = {
        title: 'Distributed Event Streaming Architecture',
        subtitle: 'Production specification for Kafka & N8N Event Router',
        author: 'Scratchbox Architecture Team',
        lastUpdated: '2026-09-05',
        tags: ['Architecture', 'Kafka', 'GoogleDocs', 'Export'],
        sections: [
            {
                id: 'sec-1',
                type: 'heading',
                level: 1,
                content: '1. Executive Summary'
            },
            {
                id: 'sec-2',
                type: 'paragraph',
                content: 'This specification outlines the high-throughput event pipeline connecting Edge Gateways with Scratchbox Cloud Agents.'
            },
            {
                id: 'sec-3',
                type: 'callout',
                calloutType: 'info',
                calloutTitle: 'Zero-Data Loss Guarantee',
                content: 'All state transitions are persisted with write-ahead logs and raft consensus.'
            },
            {
                id: 'sec-4',
                type: 'checklist',
                checklistItems: [
                    { id: 'c1', text: 'Configure Google Drive OAuth connector', done: true },
                    { id: 'c2', text: 'Validate Google Docs document styling & callout boxes', done: true },
                    { id: 'c3', text: 'Deploy automatic bi-directional synchronization', done: false }
                ]
            },
            {
                id: 'sec-5',
                type: 'table',
                tableHeaders: ['Service Name', 'Port', 'Protocol', 'SLA'],
                tableRows: [
                    ['Event Router', '8080', 'gRPC / HTTP2', '99.99%'],
                    ['Agent Worker', '9092', 'Kafka Wire', '99.95%'],
                    ['Audit Store', '5432', 'PostgreSQL', '99.999%']
                ]
            },
            {
                id: 'sec-6',
                type: 'code',
                codeLanguage: 'typescript',
                content: 'export interface EventPayload {\n  id: string;\n  topic: string;\n  timestamp: number;\n}'
            }
        ]
    };

    const gDriveService = GoogleDriveService.getInstance();
    const payload = gDriveService.convertDocumentToGoogleDocsPayload(sampleDoc);

    assert.strictEqual(payload.title, 'Distributed Event Streaming Architecture', 'Payload title matches');
    assert.strictEqual(payload.subtitle, 'Production specification for Kafka & N8N Event Router', 'Payload subtitle matches');
    assert.strictEqual(payload.author, 'Scratchbox Architecture Team', 'Author matches');
    assert.ok(payload.body && Array.isArray(payload.body.content), 'Payload body content array exists');
    assert.strictEqual(payload.body.content.length, 6, 'Contains all 6 converted sections');

    // Verify individual section structural mapping
    assert.strictEqual(payload.body.content[0].type, 'heading', 'Heading block converted');
    assert.strictEqual(payload.body.content[0].level, 1, 'Heading level preserved');
    assert.strictEqual(payload.body.content[1].type, 'paragraph', 'Paragraph block converted');
    assert.strictEqual(payload.body.content[2].type, 'callout', 'Callout block converted');
    assert.strictEqual(payload.body.content[2].calloutTitle, 'Zero-Data Loss Guarantee', 'Callout title preserved');
    assert.strictEqual(payload.body.content[3].type, 'checklist', 'Checklist block converted');
    assert.strictEqual(payload.body.content[3].checklistItems?.length, 3, 'Checklist item count preserved');
    assert.strictEqual(payload.body.content[4].type, 'table', 'Table block converted');
    assert.strictEqual(payload.body.content[4].headers?.length, 4, 'Table headers preserved');
    assert.strictEqual(payload.body.content[4].rows?.length, 3, 'Table rows preserved');
    assert.strictEqual(payload.body.content[5].type, 'code', 'Code block converted');

    console.log('  ✓ Test 1 Passed: MarkdownDocumentData accurately converted into Google Docs structured format\n');

    // =========================================================================
    // TEST 2: Raw Markdown Text to Google Docs Conversion
    // =========================================================================
    console.log('--- 2. Testing Raw Markdown Text to Google Docs Conversion ---');
    const rawMarkdown = `# System Architecture\n\nThis is a test paragraph.\n\n- [x] Step 1\n- [ ] Step 2\n\n| Service | Latency |\n| --- | --- |\n| Redis | 1ms |`;
    const markdownPayload = gDriveService.convertMarkdownToGoogleDocsPayload('System Architecture Spec', rawMarkdown);

    assert.strictEqual(markdownPayload.title, 'System Architecture Spec');
    assert.ok(markdownPayload.body.content.length >= 3, 'Parsed headings, paragraphs, checklist or tables from raw markdown');
    console.log('  ✓ Test 2 Passed: Raw markdown text parsed and converted to Google Docs payload\n');

    // =========================================================================
    // TEST 3: Connection State, Auto-Sync & Event Subscription
    // =========================================================================
    console.log('--- 3. Testing Google Drive Connection State & Auto-Sync ---');
    
    let observedState = gDriveService.getState();
    assert.ok(typeof observedState.status === 'string', 'State has a valid status');
    
    let notifiedCount = 0;
    const unsubscribe = gDriveService.subscribe(newState => {
        notifiedCount++;
        observedState = newState;
    });

    // Test connect action
    const connectedState = await gDriveService.connect('developer@scratchbox.io', 'Scratchbox Developer');
    assert.strictEqual(connectedState.status, 'connected', 'Status transitioned to connected');
    assert.strictEqual(connectedState.accountEmail, 'developer@scratchbox.io', 'Account email stored');
    assert.strictEqual(connectedState.accountName, 'Scratchbox Developer', 'Account name stored');
    assert.ok(notifiedCount > 0, 'Subscriber notified of connection change');

    // Test auto-sync toggle
    gDriveService.toggleAutoSync(true);
    assert.strictEqual(gDriveService.getState().autoSyncEnabled, true, 'Auto-sync enabled');
    gDriveService.toggleAutoSync(false);
    assert.strictEqual(gDriveService.getState().autoSyncEnabled, false, 'Auto-sync disabled');

    // Test export document simulation
    const exportResult = await gDriveService.exportDocumentToGoogleDocs(sampleDoc);
    assert.strictEqual(exportResult.success, true, 'Export marked successful');
    assert.ok(exportResult.documentId.length > 0, 'Export generated document ID');
    assert.ok(exportResult.documentUrl.includes('docs.google.com'), 'Export generated valid Google Docs link');
    assert.strictEqual(exportResult.documentTitle, 'Distributed Event Streaming Architecture');

    // Test file upload to drive
    const driveUpload = await gDriveService.saveFileToGoogleDrive('architecture.md', '# Content', 'text/markdown');
    assert.ok(driveUpload.id.length > 0, 'Drive upload returned file ID');
    assert.ok(driveUpload.webViewLink.includes('drive.google.com'), 'Drive upload returned Drive URL');

    // Test list and search files
    const driveFiles = await gDriveService.listDriveFiles();
    assert.ok(Array.isArray(driveFiles) && driveFiles.length > 0, 'Listed Google Drive files');
    const searchFiles = await gDriveService.searchDrive('Architecture');
    assert.ok(Array.isArray(searchFiles), 'Search Google Drive files succeeded');

    unsubscribe();
    console.log('  ✓ Test 3 Passed: Connection lifecycle, auto-sync toggle, document export & drive operations validated\n');

    // =========================================================================
    // TEST 4: MCP Default Servers Includes Google Drive & Docs Tool Definitions
    // =========================================================================
    console.log('--- 4. Testing Google Drive MCP Hub Tool Definitions ---');
    const driveServer = DEFAULT_MCP_SERVERS.find(s => s.id === 'mcp-google-drive');
    assert.ok(driveServer, 'DEFAULT_MCP_SERVERS includes mcp-google-drive server');
    assert.strictEqual(driveServer?.category, 'Data Storage', 'Correct category for Google Drive');
    assert.strictEqual(driveServer?.authType, 'OAuth', 'Google Drive uses OAuth');
    
    const requiredTools = ['create_document', 'upload_file', 'list_drive_files', 'search_drive'];
    const toolNames = driveServer?.tools.map(t => t.name) || [];
    for (const toolName of requiredTools) {
        assert.ok(toolNames.includes(toolName), `Google Drive MCP server must provide tool "${toolName}"`);
    }
    console.log('  ✓ Test 4 Passed: Google Drive MCP Server registered with 4 required tools in DEFAULT_MCP_SERVERS\n');

    // =========================================================================
    // TEST 5: Codebase Source Audits for UI & Components
    // =========================================================================
    console.log('--- 5. Testing Codebase UI & Component Integrations ---');
    
    const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const docPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    const settingsPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const automationsPath = path.resolve(__dirname, '../src/browser/generative-canvas/AutomationsModal.tsx');
    const iconsPath = path.resolve(__dirname, '../src/browser/generative-canvas/canvas-icons.tsx');
    const cssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const modalPath = path.resolve(__dirname, '../src/browser/generative-canvas/GoogleDriveConnectModal.tsx');

    assert.ok(fs.existsSync(studioPath), 'GenerativeCanvasStudio.tsx exists');
    assert.ok(fs.existsSync(docPath), 'MarkdownDocumentPrimitive.tsx exists');
    assert.ok(fs.existsSync(settingsPath), 'SettingsModal.tsx exists');
    assert.ok(fs.existsSync(automationsPath), 'AutomationsModal.tsx exists');
    assert.ok(fs.existsSync(iconsPath), 'canvas-icons.tsx exists');
    assert.ok(fs.existsSync(cssPath), 'unified-ui.css exists');
    assert.ok(fs.existsSync(modalPath), 'GoogleDriveConnectModal.tsx exists');

    const studioSource = fs.readFileSync(studioPath, 'utf8');
    const docSource = fs.readFileSync(docPath, 'utf8');
    const settingsSource = fs.readFileSync(settingsPath, 'utf8');
    const automationsSource = fs.readFileSync(automationsPath, 'utf8');
    const iconsSource = fs.readFileSync(iconsPath, 'utf8');
    const cssSource = fs.readFileSync(cssPath, 'utf8');
    const modalSource = fs.readFileSync(modalPath, 'utf8');

    // Icons
    assert.ok(iconsSource.includes('IconGoogleDocs'), 'canvas-icons.tsx exports IconGoogleDocs');
    assert.ok(iconsSource.includes('IconGoogleDrive'), 'canvas-icons.tsx exports IconGoogleDrive');

    // Clean Document Canvas Top Bar & Toolbar Verification
    assert.ok(docSource.includes('Download .md') || docSource.includes('Export Markdown (.md)'), 'MarkdownDocumentPrimitive preserves clean Markdown download action');
    assert.ok(studioSource.includes('Download .md'), 'GenerativeCanvasStudio top bar retains standard Download .md action');
    assert.ok(!docSource.includes('sb-doc-gdocs-btn'), 'MarkdownDocumentPrimitive top bar is clean without extra Google Docs buttons');

    // Settings Modal
    assert.ok(settingsSource.includes('Google Drive & Docs Integration') || settingsSource.includes('Google Drive &amp; Docs Integration'), 'SettingsModal contains Google Drive & Docs integration card');
    assert.ok(settingsSource.includes('create_document') && settingsSource.includes('upload_file') && settingsSource.includes('list_drive_files') && settingsSource.includes('search_drive'), 'SettingsModal displays all 4 MCP tools');
    assert.ok(settingsSource.includes('Auto-Sync Document Specs'), 'SettingsModal provides auto-sync preferences toggle');
    
    // Automations Modal
    assert.ok(automationsSource.includes('Google Drive & Docs Integration') || automationsSource.includes('Google Drive &amp; Docs Integration'), 'AutomationsModal lists Google Drive integration');
    assert.ok(automationsSource.includes('create_document') && automationsSource.includes('upload_file'), 'AutomationsModal lists Google Drive MCP tools');

    // CSS Styling
    assert.ok(cssSource.includes('sb-gdrive') || cssSource.includes('sb-status-connected'), 'unified-ui.css defines Google Drive styles');

    // GoogleDriveConnectModal
    assert.ok(modalSource.includes('GoogleDriveConnectModal'), 'GoogleDriveConnectModal exported');
    assert.ok(modalSource.includes('Connect with Google OAuth') || modalSource.includes('Google Drive'), 'Modal provides OAuth connect workflow');

    console.log('  ✓ Test 5 Passed: All files, components, icons, and clean top-bar specifications verified\n');

    console.log('🎉 ALL GOOGLE DRIVE & GOOGLE DOCS INTEGRATION TESTS PASSED SUCCESSFULLY!');
}

runGoogleDriveIntegrationTests().catch(err => {
    console.error('❌ Google Drive Integration Test Failed:', err);
    process.exit(1);
});
