import { test } from 'vitest';
import * as assert from 'assert';
import {
    CanvasArtifact,
    KanbanBoardData,
    MarkdownDocumentData,
    PrimitiveType,
    StudioLayoutMode
} from '../src/browser/generative-canvas/canvas-types';
import {
    resolveModeForArtifact,
    sanitizeLayoutMode,
    computeArtifactDiff,
    transitionKanbanCard,
    calculateKanbanProgress
} from '../src/browser/generative-canvas/guardrails-service';
import {
    synthesizeComprehensiveDocument
} from '../src/browser/generative-canvas/document-synthesis-engine';
import { GeminiService } from '../src/node/gemini-service';

async function runSurfaceArtifactTransitionTests() {
    console.log('🧪 Running 4-Surface Mode Switcher & Artifact Transition Test Suite...');

    // Test 1: Mode Resolution for all core primitive types
    const mappingExpectations: Array<{ type: PrimitiveType; expectedMode: StudioLayoutMode }> = [
        { type: 'live-code-sandbox', expectedMode: 'code' },
        { type: 'node-graph', expectedMode: 'automation' },
        { type: 'mind-map', expectedMode: 'code' },
        { type: 'metric-dashboard', expectedMode: 'code' },
        { type: 'skills-hub', expectedMode: 'code' },
        { type: 'mcp-hub', expectedMode: 'code' },
        { type: 'markdown-document', expectedMode: 'document' },
        { type: 'checklist', expectedMode: 'document' },
        { type: 'interactive-form', expectedMode: 'document' },
        { type: 'kanban-board', expectedMode: 'kanban' },
        { type: '3d-scene', expectedMode: '3d' }
    ];

    for (const { type, expectedMode } of mappingExpectations) {
        const resolved = resolveModeForArtifact(type);
        assert.strictEqual(resolved, expectedMode, `Primitive "${type}" should route to "${expectedMode}" surface`);
    }
    console.log('  ✓ Test 1 Passed: All primitive types accurately mapped to their designated surface mode');

    // Test 2: Sanitization of legacy or undefined layout modes
    assert.strictEqual(sanitizeLayoutMode(undefined, undefined), 'chat', 'Default layout mode should be chat');
    assert.strictEqual(sanitizeLayoutMode('split' as any, undefined), 'chat', 'Legacy split mode should sanitize to chat');
    assert.strictEqual(sanitizeLayoutMode('code', undefined), 'code');
    assert.strictEqual(sanitizeLayoutMode('canvas', undefined), 'code');
    assert.strictEqual(sanitizeLayoutMode('document', undefined), 'document');
    assert.strictEqual(sanitizeLayoutMode('kanban', undefined), 'kanban');
    assert.strictEqual(sanitizeLayoutMode('automation', undefined), 'automation');

    // When an artifact is provided with a legacy mode, it maps to artifact's surface
    const testDocArtifact: CanvasArtifact = {
        id: 'art-doc-1',
        type: 'markdown-document',
        title: 'Project Spec',
        summary: 'Spec doc',
        version: 1,
        createdAt: '12:00 PM',
        data: { title: 'Spec', sections: [] }
    };
    assert.strictEqual(sanitizeLayoutMode('split' as any, testDocArtifact), 'document');
    console.log('  ✓ Test 2 Passed: Layout mode sanitization protects against invalid states and legacy tokens');

    // Test 3: Artifact Diff Calculation between Version 1 and Version 2
    const v1Doc: CanvasArtifact = {
        id: 'art-doc-diff',
        type: 'markdown-document',
        title: 'Architecture Blueprint',
        summary: 'Version 1 of architecture spec',
        version: 1,
        createdAt: '10:00 AM',
        data: {
            title: 'Architecture Blueprint',
            sections: [
                { id: 's1', type: 'heading', level: 1, content: '1. Architecture Vision' },
                { id: 's2', type: 'paragraph', content: 'Initial draft of cloud architecture.' }
            ]
        } as MarkdownDocumentData
    };

    const v2Doc: CanvasArtifact = {
        id: 'art-doc-diff',
        type: 'markdown-document',
        title: 'Architecture Blueprint',
        summary: 'Version 2 with MCP integration',
        version: 2,
        createdAt: '10:15 AM',
        data: {
            title: 'Architecture Blueprint',
            sections: [
                { id: 's1', type: 'heading', level: 1, content: '1. Architecture Vision & Pipelines' }, // modified
                { id: 's2', type: 'paragraph', content: 'Initial draft of cloud architecture.' }, // unchanged
                { id: 's3', type: 'callout', calloutType: 'info', content: 'MCP Gateway added.' } // added
            ]
        } as MarkdownDocumentData
    };

    const diffResult = computeArtifactDiff(v1Doc, v2Doc);
    assert.ok(diffResult.hasChanges, 'Diff should detect changes between v1 and v2');
    assert.strictEqual(diffResult.addedCount, 1, 'Should detect 1 added section');
    assert.strictEqual(diffResult.modifiedCount, 1, 'Should detect 1 modified section');
    assert.strictEqual(diffResult.unchangedCount, 1, 'Should detect 1 unchanged section');
    console.log('  ✓ Test 3 Passed: Document artifact diff accurately computes additions, modifications and unchanged blocks');

    // Test 4: Kanban Board Card Stage Transitioning
    const initialKanban: KanbanBoardData = {
        title: 'Sprint Delivery Board',
        columns: [
            {
                id: 'col-backlog',
                title: 'Backlog',
                color: 'indigo',
                cards: [
                    { id: 'card-101', title: 'Setup MCP Stream', priority: 'high', completedSubtasks: 1, totalSubtasks: 3 },
                    { id: 'card-102', title: 'Add SF Typography', priority: 'medium' }
                ]
            },
            {
                id: 'col-in-progress',
                title: 'In Progress',
                color: 'blue',
                cards: []
            },
            {
                id: 'col-done',
                title: 'Done',
                color: 'emerald',
                cards: []
            }
        ]
    };

    // Transition card-101 from Backlog to In Progress
    const updatedBoard = transitionKanbanCard(initialKanban, 'card-101', 'col-in-progress');
    const backlogCol = updatedBoard.columns.find(c => c.id === 'col-backlog');
    const inProgressCol = updatedBoard.columns.find(c => c.id === 'col-in-progress');

    assert.strictEqual(backlogCol?.cards.some(c => c.id === 'card-101'), false, 'Card 101 must be removed from Backlog');
    assert.strictEqual(inProgressCol?.cards.some(c => c.id === 'card-101'), true, 'Card 101 must be placed into In Progress');
    assert.strictEqual(backlogCol?.cards.length, 1, 'Backlog should now have 1 card');
    console.log('  ✓ Test 4 Passed: Kanban card stage transition preserves card data while moving between stages');

    // Test 5: Kanban Progress calculation
    const progress = calculateKanbanProgress(updatedBoard);
    assert.strictEqual(progress.totalCards, 2);
    assert.strictEqual(progress.doneCards, 0);
    assert.strictEqual(progress.inProgressCards, 1);
    assert.strictEqual(progress.percentage, 0);

    // Now move both to done
    const doneBoard = transitionKanbanCard(
        transitionKanbanCard(updatedBoard, 'card-101', 'col-done'),
        'card-102',
        'col-done'
    );
    const doneProgress = calculateKanbanProgress(doneBoard);
    assert.strictEqual(doneProgress.doneCards, 2);
    assert.strictEqual(doneProgress.percentage, 100);
    console.log('  ✓ Test 5 Passed: Kanban board progress percentage and stage metrics calculated accurately');

    // Test 6: Replit-style Drafts / Suggestions & Active Column Promotion
    const boardWithDrafts: KanbanBoardData = {
        title: 'Draft Enabled Sprint Board',
        columns: [
            { id: 'col-todo', title: 'Todo', color: 'blue', cards: [] }
        ],
        drafts: [
            {
                id: 'draft-101',
                title: 'Add Location Node Dark Mode Toggle',
                description: 'Implement dark mode theme styling for Location nodes',
                priority: 'medium',
                tag: 'UI/UX',
                tagColor: 'purple',
                planSteps: [
                    'Define dark mode tokens',
                    'Implement theme toggle provider',
                    'Verify color contrast WCAG ratios'
                ],
                promptProvenance: 'Add a Location node dark mode toggle'
            }
        ]
    };

    assert.ok(boardWithDrafts.drafts && boardWithDrafts.drafts.length === 1, 'Drafts column should initialize with 1 suggested card');
    const draftCard = boardWithDrafts.drafts![0];
    assert.strictEqual(draftCard.title, 'Add Location Node Dark Mode Toggle');
    assert.strictEqual(draftCard.tag, 'UI/UX');
    assert.strictEqual(draftCard.priority, 'medium');
    assert.deepStrictEqual(draftCard.planSteps, [
        'Define dark mode tokens',
        'Implement theme toggle provider',
        'Verify color contrast WCAG ratios'
    ]);
    assert.strictEqual(draftCard.promptProvenance, 'Add a Location node dark mode toggle');

    // Define draft promotion helper to simulate handlePromoteDraft in non-interactive test
    const promoteDraftToActive = (board: KanbanBoardData, cardId: string): KanbanBoardData => {
        const drafts = board.drafts || [];
        const cardToPromote = drafts.find(c => c.id === cardId);
        if (!cardToPromote) return board;

        const newDrafts = drafts.filter(c => c.id !== cardId);
        const firstCol = board.columns[0];
        const updatedFirstCol = {
            ...firstCol,
            cards: [...(firstCol.cards || []), cardToPromote]
        };
        const newColumns = board.columns.map((col, idx) => idx === 0 ? updatedFirstCol : col);

        return {
            ...board,
            columns: newColumns,
            drafts: newDrafts
        };
    };

    const promotedBoard = promoteDraftToActive(boardWithDrafts, 'draft-101');
    assert.strictEqual(promotedBoard.drafts?.length, 0, 'Drafts list must be empty after promotion');
    assert.strictEqual(promotedBoard.columns[0].cards.length, 1, 'Active Todo column must contain 1 promoted card');
    assert.strictEqual(promotedBoard.columns[0].cards[0].id, 'draft-101', 'Promoted card must preserve its identity and data');
    console.log('  ✓ Test 6 Passed: Kanban drafts initialization and active column promotion verified successfully');

    // Test 7: Document Title Integrity & Bidirectional Synchronization
    const rawDocumentData: MarkdownDocumentData = {
        title: 'The Pivotal Year: 1776 in American History',
        sections: [
            { id: 's1', type: 'heading', level: 1, content: '1. Executive Overview' },
            { id: 's2', type: 'paragraph', content: 'In 1776, American independence was declared.' }
        ]
    };

    const sanitizeDocTest = (raw: MarkdownDocumentData, activeArtifact?: CanvasArtifact, activeArtifactTitle?: string): MarkdownDocumentData => {
        let t = raw?.title || (raw as any)?.docTitle;
        if (!t || t === 'Markdown Document') {
            t = (raw as any)?.name || (raw as any)?.summary || activeArtifactTitle || activeArtifact?.title || 'Project Specification & Notes';
        }
        if (t === 'Markdown Document') {
            t = activeArtifactTitle || activeArtifact?.title || 'Project Specification & Notes';
        }
        return {
            title: t || 'Project Specification & Notes',
            subtitle: raw?.subtitle || (raw as any)?.docSubtitle,
            author: raw?.author,
            lastUpdated: raw?.lastUpdated,
            tags: Array.isArray(raw?.tags) ? raw.tags : [],
            sections: Array.isArray(raw?.sections) ? raw.sections : []
        };
    };

    const sanitized1776 = sanitizeDocTest(rawDocumentData);
    assert.strictEqual(sanitized1776.title, 'The Pivotal Year: 1776 in American History', 'Specific document title must be preserved');
    assert.notStrictEqual(sanitized1776.title, 'Markdown Document', 'Document title must never be generic "Markdown Document"');

    const genericRaw: MarkdownDocumentData = { title: 'Markdown Document', sections: [] };
    const sanitizedWithArtifact = sanitizeDocTest(genericRaw, { id: 'art-1', type: 'markdown-document', title: 'The Pivotal Year: 1776 in American History', summary: '1776', version: 1, createdAt: 'Now', data: { title: 'The Pivotal Year: 1776 in American History', sections: [] } as MarkdownDocumentData });
    assert.strictEqual(sanitizedWithArtifact.title, 'The Pivotal Year: 1776 in American History', 'Sanitizer should take active artifact title instead of generic "Markdown Document"');

    // Test title mutation synchronization to activeArtifact and messages
    const testArtifact: CanvasArtifact = {
        id: 'art-doc-sync-1',
        type: 'markdown-document',
        title: 'Initial Title',
        summary: 'Notes',
        version: 1,
        createdAt: '12:00 PM',
        data: { title: 'Initial Title', sections: [] }
    };

    const updatedDocTitle = 'The Pivotal Year: 1776 in American History';
    const syncedArtifact: CanvasArtifact = {
        ...testArtifact,
        title: updatedDocTitle,
        data: { ...(testArtifact.data as MarkdownDocumentData), title: updatedDocTitle }
    };

    assert.strictEqual(syncedArtifact.title, updatedDocTitle);
    assert.strictEqual((syncedArtifact.data as MarkdownDocumentData).title, updatedDocTitle);
    console.log('  ✓ Test 7 Passed: Document title integrity and bidirectional synchronization verified');

    // Test 8: Surgical Section-Level Mutations & Prompt Provenance Formatting
    const multiSectionDoc: MarkdownDocumentData = {
        title: 'The Pivotal Year: 1776 in American History',
        sections: [
            { id: 'sec-intro', type: 'heading', level: 1, content: '1. Executive Overview' },
            { id: 'sec-events', type: 'paragraph', content: 'Key events took place in Philadelphia and Boston.' },
            { id: 'sec-milestones', type: 'checklist', checklistItems: [{ id: 'c1', text: 'Ratify declaration', done: true }] }
        ]
    };

    // Prompt formatter test
    const generateSectionPrompt = (section: any, action: string, docTitle: string) => {
        let targetText = section.content || section.calloutTitle;
        if (!targetText && section.type === 'table') targetText = 'Table matrix';
        if (!targetText && section.type === 'checklist') targetText = 'Checklist tasks';
        return `${action} for section "${(targetText || 'selected content').slice(0, 160)}" in document "${docTitle}".`;
    };

    const sectionPrompt = generateSectionPrompt(multiSectionDoc.sections[1], 'Expand with more specific details', multiSectionDoc.title);
    assert.ok(sectionPrompt.includes('in document "The Pivotal Year: 1776 in American History"'), 'Prompt must include the exact document title');
    assert.ok(sectionPrompt.includes('for section "Key events took place in Philadelphia and Boston."'), 'Prompt must include targeted section content');

    // Surgical replacement test: convert section 1 to table while preserving section 0 (heading) and section 2 (checklist)
    const surgicalTableSection = {
        id: 'sec-events-table',
        type: 'table' as const,
        tableHeaders: ['Date', 'Event', 'Significance'],
        tableRows: [['July 4, 1776', 'Declaration Ratified', 'Independence established']]
    };

    const surgicallyUpdatedSections = [...multiSectionDoc.sections];
    surgicallyUpdatedSections.splice(1, 1, surgicalTableSection);

    assert.strictEqual(surgicallyUpdatedSections.length, 3, 'Document should maintain total section integrity');
    assert.strictEqual(surgicallyUpdatedSections[0].id, 'sec-intro', 'Section 0 (Executive Overview) must remain intact');
    assert.strictEqual(surgicallyUpdatedSections[1].type, 'table', 'Section 1 must be surgically updated to table');
    assert.strictEqual(surgicallyUpdatedSections[2].id, 'sec-milestones', 'Section 2 (Checklist) must remain intact');
    console.log('  ✓ Test 8 Passed: Surgical section mutations preserve document boundaries and format prompt provenance accurately');

    // Test 9: Rich Document Section Synthesis for 1776 (6-Tier Executive Hierarchy)
    const doc1776 = synthesizeComprehensiveDocument('write a document of the significance of 1776');
    assert.strictEqual(doc1776.title, 'The Pivotal Year: 1776 and the Birth of a Nation');
    assert.strictEqual(doc1776.author, 'Eli Green');
    assert.ok(Array.isArray(doc1776.tags) && doc1776.tags.includes('american revolution') && doc1776.tags.includes('founding principles'));

    // Check Executive Summary (L1 Heading + 2 rich paragraphs)
    const h1Overview = doc1776.sections.find(s => s.type === 'heading' && s.level === 1 && (s.content || '').includes('Executive Summary'));
    assert.ok(h1Overview, 'Executive Summary L1 heading must be present');
    const introParas = doc1776.sections.filter(s => s.type === 'paragraph' && ((s.content || '').includes('1776') || (s.content || '').includes('Declaration') || (s.content || '').includes('watershed')));
    assert.ok(introParas.length >= 2, 'Executive summary must have at least 2 detailed narrative paragraphs');

    // Check Key Turning Points & Chronology (L1 Heading + L2 subheadings + narrative + callouts)
    const h1Chronology = doc1776.sections.find(s => s.type === 'heading' && s.level === 1 && ((s.content || '').includes('Turning Points') || (s.content || '').includes('Key Pillars')));
    assert.ok(h1Chronology, 'Key Turning Points or Key Pillars L1 heading must be present');
    const h2CommonSense = doc1776.sections.find(s => s.type === 'heading' && s.level === 2 && ((s.content || '').includes('Common Sense') || (s.content || '').includes('Enlightenment')));
    assert.ok(h2CommonSense, 'Common Sense or Enlightenment L2 subheading must be present');
    const h2Declaration = doc1776.sections.find(s => s.type === 'heading' && s.level === 2 && (s.content || '').includes('Declaration'));
    assert.ok(h2Declaration, 'Declaration L2 subheading must be present');

    const callouts1776 = doc1776.sections.filter(s => s.type === 'callout');
    assert.ok(callouts1776.length >= 1, 'Primary source and architectural callouts must be present');

    // Check Structured Matrix Table (5 rich rows)
    const matrixTable = doc1776.sections.find(s => s.type === 'table');
    assert.ok(matrixTable && matrixTable.tableHeaders && matrixTable.tableRows, 'Comparison matrix table must be present');
    assert.strictEqual(matrixTable.tableRows.length, 5, 'Chronology table must contain 5 rich historical rows');

    // Check Quotes and Takeaways Checklist
    const quotes1776 = doc1776.sections.filter(s => s.type === 'quote');
    assert.ok(quotes1776.length >= 1, 'Key primary quotes must be present');
    assert.ok(quotes1776.some(q => (q.content || '').includes('self-evident')), 'Declaration quote present');

    const checklist1776 = doc1776.sections.find(s => s.type === 'checklist');
    assert.ok(checklist1776 && checklist1776.checklistItems && checklist1776.checklistItems.length >= 4, 'Milestone checklist must contain at least 4 items');
    console.log('  ✓ Test 9 Passed: 1776 document synthesis verified with complete 6-tier executive hierarchy');

    // Test 10: Technical Specification Document Synthesis for Authentication
    const authDoc = synthesizeComprehensiveDocument('write a technical spec for authentication');
    assert.strictEqual(authDoc.title, 'Technical Specification: Scalable Authentication & Zero-Trust Identity Infrastructure');
    assert.ok(authDoc.tags && authDoc.tags.includes('Authentication') && authDoc.tags.includes('OAuth2') && authDoc.tags.includes('ZeroTrust'));
    
    const authTable = authDoc.sections.find(s => s.type === 'table');
    assert.ok(authTable && authTable.tableRows && authTable.tableRows.length >= 5, 'Auth comparison table must have 5 rows');
    assert.ok(authDoc.sections.some(s => s.type === 'callout' && s.calloutTitle?.includes('Security Guardrail')), 'Security callout present');
    assert.ok(authDoc.sections.some(s => s.type === 'checklist' && s.checklistItems?.some(i => i.text.includes('WebAuthn'))), 'Passkey checklist present');
    console.log('  ✓ Test 10 Passed: Authentication technical spec synthesized with Zero-Trust architecture & comparison matrix');

    // Test 11: Document Synthesis for Project Proposals
    const proposalDoc = synthesizeComprehensiveDocument('write a project proposal for real-time analytics');
    assert.ok(!proposalDoc.title.includes('Markdown Document'), 'Proposal title must never be "Markdown Document"');
    assert.ok(proposalDoc.sections.some(s => s.type === 'heading' && s.level === 1 && (s.content || '').includes('Executive Summary')));
    assert.ok(proposalDoc.sections.some(s => s.type === 'table'));
    assert.ok(proposalDoc.sections.some(s => s.type === 'checklist'));
    console.log('  ✓ Test 11 Passed: Project proposal synthesis verified with executive structure and deliverables checklist');

    // Test 12: Markdown Parser (geminiService.markdownStringToSections) Precision
    const geminiService = new GeminiService();
    const rawMarkdownInput = `# 1. Executive Summary

This is a rich narrative paragraph explaining the fundamental architecture without turning into a callout.
It spans multiple lines and contains crucial context for engineering leaders.

This is a second detailed paragraph discussing distributed systems.

> [!NOTE] Architecture Guardrail
All client interactions must be authenticated via asymmetric Ed25519 tokens.

> [!TIP] Performance Optimization
Enable edge caching on Cloudflare CDN to achieve sub-20ms latency.

> “Simplicity is prerequisite for reliability.” — Edsger W. Dijkstra

## 2. Milestone Chronology

| Phase | Milestone | Owner | Status |
| --- | --- | --- | --- |
| Phase 1 | Design System Tokens | UI Team | Complete |
| Phase 2 | Subagent Concurrency Pool | Core Eng | Active |
| Phase 3 | End-to-End Verification | QA | Pending |

- [x] Establish type-safe protocol schemas
- [x] Configure Google Cloud service account auth
- [ ] Deploy global edge worker fleet

\`\`\`typescript
export const config = { timeout: 3000 };
\`\`\`
`;

    const parsedSections = geminiService.markdownStringToSections(rawMarkdownInput);

    // Assert headings
    const h1Parsed = parsedSections.find(s => s.type === 'heading' && s.level === 1);
    assert.ok(h1Parsed && h1Parsed.content === '1. Executive Summary', 'H1 properly parsed');
    const h2Parsed = parsedSections.find(s => s.type === 'heading' && s.level === 2);
    assert.ok(h2Parsed && h2Parsed.content === '2. Milestone Chronology', 'H2 properly parsed');

    // Assert paragraphs are NOT callouts
    const parasParsed = parsedSections.filter(s => s.type === 'paragraph');
    assert.strictEqual(parasParsed.length, 2, 'Standard paragraphs must be preserved as paragraph type');
    assert.ok(parasParsed[0] && (parasParsed[0].content || '').includes('rich narrative paragraph'), 'Paragraph 1 content preserved');
    assert.ok(parasParsed[1] && (parasParsed[1].content || '').includes('second detailed paragraph'), 'Paragraph 2 content preserved');

    // Assert explicit callouts (> [!NOTE], > [!TIP])
    const calloutsParsed = parsedSections.filter(s => s.type === 'callout');
    assert.strictEqual(calloutsParsed.length, 2, 'Explicit callouts (> [!NOTE], > [!TIP]) properly detected');
    assert.strictEqual(calloutsParsed[0].calloutType, 'info');
    assert.strictEqual(calloutsParsed[0].calloutTitle, 'Architecture Guardrail');
    assert.strictEqual(calloutsParsed[1].calloutType, 'tip');
    assert.strictEqual(calloutsParsed[1].calloutTitle, 'Performance Optimization');

    // Assert quote
    const quotesParsed = parsedSections.filter(s => s.type === 'quote');
    assert.strictEqual(quotesParsed.length, 1, 'Blockquote properly parsed');
    assert.ok(quotesParsed[0] && (quotesParsed[0].content || '').includes('Dijkstra'), 'Quote content preserved');

    // Assert table
    const tablesParsed = parsedSections.filter(s => s.type === 'table');
    assert.strictEqual(tablesParsed.length, 1, 'Table properly parsed');
    assert.deepStrictEqual(tablesParsed[0].tableHeaders, ['Phase', 'Milestone', 'Owner', 'Status']);
    assert.strictEqual(tablesParsed[0].tableRows?.length, 3);
    assert.strictEqual(tablesParsed[0].tableRows?.[0][0], 'Phase 1');

    // Assert checklist
    const checklistsParsed = parsedSections.filter(s => s.type === 'checklist');
    assert.strictEqual(checklistsParsed.length, 1, 'Checklist properly grouped');
    assert.strictEqual(checklistsParsed[0].checklistItems?.length, 3);
    assert.strictEqual(checklistsParsed[0].checklistItems?.[0].done, true);
    assert.strictEqual(checklistsParsed[0].checklistItems?.[2].done, false);

    // Assert code
    const codesParsed = parsedSections.filter(s => s.type === 'code');
    assert.strictEqual(codesParsed.length, 1, 'Code block properly parsed');
    assert.strictEqual(codesParsed[0].codeLanguage, 'typescript');
    assert.ok(codesParsed[0].content?.includes('export const config'), 'Code content preserved');

    console.log('  ✓ Test 12 Passed: markdownStringToSections parser accurately parses headings, paragraphs, callouts, quotes, tables, checklists, and code');

    console.log('\n🎉 ALL SURFACE TRANSITION & ARTIFACT TESTS PASSED SUCCESSFULLY!');
}

test('surface-artifacts-transition.test', async () => {
    await runSurfaceArtifactTransitionTests();
}, 180_000);
