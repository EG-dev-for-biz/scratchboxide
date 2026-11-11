/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as ts from 'typescript';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    CodeSymbol,
    ContextGraphEdge,
    ContextGraphNode,
    ContextGraphSlice,
    ContextGraphSliceOptions,
    ContextRelationType,
    ProjectContextGraph,
    SymbolGraphQuery,
    SymbolGraphResult,
    SymbolKind
} from '../common/context-graph-protocol';
import {
    CodeFileTab,
    KanbanBoardData,
    MarkdownDocumentData,
    NodeGraphData
} from '../browser/generative-canvas/canvas-types';

/**
 * A dependency name resolves across files only while it identifies this few symbols. One is the honest number: a
 * name two files both declare does not say which one is meant, and linking both (or eight) states a relationship the
 * source never showed. Same-file declarations are resolved first and are not subject to this.
 */
const AMBIGUOUS_DEPENDENCY_FANOUT = 1;

/**
 * The source extensions the symbol extractors can read. Data and markup (`.json`, `.css`, images, `.md`) yield no
 * symbol and would enter the graph as file nodes alone, crowding out code in every slice, so they are left out; a
 * caller that wants them passes its own `extensions`.
 */
const INDEXABLE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.cpp', '.cc', '.c', '.h', '.hpp'];

/**
 * Directory names skipped by the directory walk (the fallback for a root that is not a git worktree): dependencies,
 * build output, caches, and the agent and asset trees that hold no source of this project's own. The git enumeration
 * needs none of this — `.gitignore` already says what is not ours.
 */
const UNINDEXED_DIRECTORIES = [
    'node_modules', '.git', 'dist', 'lib', 'build', 'out', 'coverage', '.cache', '.turbo', '.next', '.vite',
    '.claude', '.agents', '.scratchbox', '.model-cache', '.venv', 'venv', '__pycache__',
    'public', 'assets', 'test-results', 'vendor', 'third_party'
];

/** A file larger than this is generated, minified or vendored, whatever its extension; parsing it buys nothing. */
const MAX_INDEXED_FILE_BYTES = 512 * 1024;

/** Files parsed between yields, so a boot-time index of a large repository does not hold the event loop. */
const INDEX_YIELD_INTERVAL = 25;

/**
 * Words a request is phrased in rather than words the code is written in. They appear in most prompts and in most
 * source files, so they rank nothing and only add matches that look considered.
 */
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'using', 'get', 'set',
    'what', 'why', 'how', 'when', 'where', 'which', 'does', 'did', 'are', 'was', 'were',
    'can', 'should', 'would', 'could', 'has', 'have', 'its', 'you', 'please', 'there', 'here',
    'all', 'any', 'not', 'but', 'our', 'out', 'use', 'via', 'per', 'then', 'than', 'they'
]);

/** A letter or digit: inside an identifier or a word, rather than at its edge. */
function isWordCharacter(ch: string | undefined): boolean {
    return ch !== undefined && /[a-z0-9]/.test(ch);
}

/**
 * Whether `needle` appears in `haystack` as a word of its own — flanked by punctuation, space or nothing, never by
 * more letters. Done with indexOf rather than a RegExp because this runs once per indexed symbol per query.
 */
function containsAtWordBoundary(haystack: string, needle: string): boolean {
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) {
            return false;
        }
        if (!isWordCharacter(haystack[at - 1]) && !isWordCharacter(haystack[at + needle.length])) {
            return true;
        }
        from = at + 1;
    }
}

export class ProjectContextGraphService {
    private nodes: Map<string, ContextGraphNode> = new Map();
    private edges: ContextGraphEdge[] = [];
    private symbols: Map<string, CodeSymbol> = new Map();
    private fileToSymbols: Map<string, string[]> = new Map(); // filePath -> symbolId[]
    private symbolNameToIds: Map<string, string[]> = new Map(); // symbolName.toLowerCase() -> symbolId[]
    /**
     * `edges` indexed by endpoint, so expansion walks a node's neighbours instead of every edge — and so an insert
     * dedupes against one node's own edges instead of scanning the whole list.
     */
    private outgoing: Map<string, ContextGraphEdge[]> = new Map();
    private incoming: Map<string, ContextGraphEdge[]> = new Map();
    /**
     * The last scoring pass, kept because a single turn scores the same query twice (the prompt builder takes the
     * symbol subgraph, then a slice of the same prompt, asking for a different number of symbols each time) and
     * scoring every indexed symbol is the expensive part, while choosing the top N from the scores is not. Keyed by
     * what scoring reads and by the index's own version, so an edit anywhere invalidates it.
     */
    private lastScoring?: { key: string; indexedAt: number; scores: Map<string, number> };
    private lastUpdated: number = Date.now();

    /**
     * Ingest an active Markdown Document Spec into the project context graph.
     */
    ingestDocumentSpec(doc: MarkdownDocumentData, specId: string = 'doc-spec'): void {
        const rootNodeId = specId;
        const sections = Array.isArray(doc?.sections) ? doc.sections : [];
        const summary = `${doc.title || 'Spec'}: ${doc.subtitle || ''}. ${sections.length} sections defined.`;

        const fullText = sections.map(s => {
            const secHeading = (s as any).title || s.calloutTitle || s.type;
            return `## ${secHeading}\n${s.content || ''}`;
        }).join('\n\n');

        this.nodes.set(rootNodeId, {
            id: rootNodeId,
            type: 'spec',
            title: doc.title || 'Project Specification',
            summary,
            content: fullText,
            metadata: {
                subtitle: doc.subtitle,
                author: doc.author,
                tags: doc.tags,
                sectionCount: sections.length
            },
            tokenCount: Math.ceil(fullText.length / 4)
        });

        // Ingest section checklist items as granular sub-nodes
        sections.forEach((sec, sIdx) => {
            const secHeading = (sec as any).title || sec.calloutTitle || `Section ${sIdx + 1}`;
            if (Array.isArray(sec.checklistItems)) {
                sec.checklistItems.forEach((chk, cIdx) => {
                    const isDone = !!(chk.done || (chk as any).completed);
                    const chkNodeId = `${rootNodeId}-chk-${sIdx}-${cIdx}`;
                    this.nodes.set(chkNodeId, {
                        id: chkNodeId,
                        type: 'kanban-task',
                        title: chk.text,
                        summary: `Checklist item in "${secHeading}" (${isDone ? 'completed' : 'pending'})`,
                        metadata: {
                            completed: isDone,
                            sectionTitle: secHeading
                        },
                        tokenCount: Math.ceil(chk.text.length / 4)
                    });
                    this.addEdge(rootNodeId, chkNodeId, 'parent_of');
                });
            }
        });

        this.lastUpdated = Date.now();
    }

    /**
     * Ingest multi-file Live Code Sandbox tabs into the project context graph.
     */
    ingestSandboxTabs(tabs: CodeFileTab[], sandboxId: string = 'sandbox'): void {
        for (const tab of tabs) {
            const tabPath = tab.path || tab.name;
            const nodeId = `${sandboxId}-${tabPath}`;
            const isTest = tabPath.includes('.test.') || tabPath.includes('.spec.');
            const content = tab.content || '';

            this.nodes.set(nodeId, {
                id: nodeId,
                type: 'sandbox-file',
                title: tab.name,
                path: tabPath,
                summary: `Sandbox ${tab.language || 'code'} file: ${tab.name} (${content.length} chars)`,
                content,
                metadata: {
                    language: tab.language,
                    isTest
                },
                tokenCount: Math.ceil(content.length / 4)
            });

            // Index AST symbols for this sandbox tab
            if (content.trim()) {
                this.indexSourceFile(tabPath, content, tab.language);
            }

            // If it is a test file, find corresponding implementation file and connect edge
            if (isTest) {
                const targetName = tab.name.replace(/\.(test|spec)\./, '.');
                for (const otherTab of tabs) {
                    if (otherTab.name === targetName) {
                        const targetNodeId = `${sandboxId}-${otherTab.path || otherTab.name}`;
                        this.addEdge(nodeId, targetNodeId, 'tests');
                    }
                }
            }
        }
        this.lastUpdated = Date.now();
    }

    /**
     * Ingest a Kanban Board into the project context graph.
     */
    ingestKanbanBoard(board: KanbanBoardData, boardId: string = 'kanban'): void {
        const columns = Array.isArray(board?.columns) ? board.columns : [];

        for (const col of columns) {
            const cards = Array.isArray(col.cards) ? col.cards : [];
            for (const card of cards) {
                const nodeId = `${boardId}-${card.id}`;
                this.nodes.set(nodeId, {
                    id: nodeId,
                    type: 'kanban-task',
                    title: card.title,
                    summary: `Task in "${col.title}" column. Priority: ${card.priority || 'medium'}. Tag: ${card.tag || 'General'}`,
                    content: card.description,
                    metadata: {
                        column: col.title,
                        priority: card.priority,
                        tag: card.tag
                    },
                    tokenCount: Math.ceil((card.title.length + (card.description?.length || 0)) / 4)
                });
            }
        }
        this.lastUpdated = Date.now();
    }

    /**
     * Ingest a Visual Node Graph into the project context graph.
     */
    ingestNodeGraph(graph: NodeGraphData, graphId: string = 'graph'): void {
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];

        for (const node of nodes) {
            const nodeId = `${graphId}-${node.id}`;
            const nodeTitle = node.label || (node as any).title || 'Step';
            const nodeCategory = node.category || (node as any).type || 'process';
            const nodeDesc = node.details || node.notes || (node as any).description;

            this.nodes.set(nodeId, {
                id: nodeId,
                type: 'node-step',
                title: nodeTitle,
                summary: `Node Graph step: ${nodeCategory} (${nodeTitle})`,
                content: nodeDesc,
                metadata: {
                    nodeType: nodeCategory,
                    status: node.status,
                    parameters: node.parameters
                },
                tokenCount: Math.ceil((nodeTitle.length + (nodeDesc?.length || 0)) / 4)
            });
        }

        for (const edge of edges) {
            const sourceId = edge.source || (edge as any).sourceNodeId;
            const targetId = edge.target || (edge as any).targetNodeId;
            this.addEdge(`${graphId}-${sourceId}`, `${graphId}-${targetId}`, 'depends_on');
        }

        this.lastUpdated = Date.now();
    }

    // =========================================================================
    // SECTION: AST Codebase Indexing & Semantic Symbol Graph
    // =========================================================================

    /**
     * Parse source code into AST symbols (functions, classes, interfaces, types, imports, exports)
     * and wire them as nodes and edges in the project context graph.
     */
    indexSourceFile(filePath: string, content: string, language?: string): CodeSymbol[] {
        const cleanPath = filePath.replace(/\\/g, '/');
        const fileNodeId = `file:${cleanPath}`;

        // Create or update file node
        this.nodes.set(fileNodeId, {
            id: fileNodeId,
            type: 'workspace-file',
            title: path.basename(cleanPath),
            path: cleanPath,
            summary: `Source file: ${cleanPath} (${Math.ceil(content.length / 4)} tokens)`,
            content: content.slice(0, 1500),
            tokenCount: Math.ceil(content.length / 4)
        });

        // Remove old symbols indexed for this file
        this.forgetSymbolsOf(cleanPath);

        const symbols: CodeSymbol[] = [];
        const isTsOrJs = /\.(tsx?|jsx?|mjs|cjs)$/i.test(cleanPath) || language === 'typescript' || language === 'javascript' || language === 'react';

        if (isTsOrJs) {
            symbols.push(...this.extractTypeScriptAstSymbols(cleanPath, content));
        } else {
            symbols.push(...this.extractMultiLanguageSymbols(cleanPath, content, language));
        }

        const newSymbolIds: string[] = [];

        for (const sym of symbols) {
            this.symbols.set(sym.id, sym);
            newSymbolIds.push(sym.id);

            // Register symbol node
            const symNodeId = sym.id;
            const nodeType = (sym.kind === 'interface' || sym.kind === 'class' || sym.kind === 'function' || sym.kind === 'type')
                ? sym.kind
                : 'symbol';

            this.nodes.set(symNodeId, {
                id: symNodeId,
                type: nodeType as any,
                title: sym.name,
                path: cleanPath,
                summary: `${sym.kind.toUpperCase()} \`${sym.name}\`${sym.signature ? `: ${sym.signature}` : ''}${sym.docstring ? ` — ${sym.docstring}` : ''}`,
                content: sym.bodySummary || sym.signature || sym.name,
                metadata: {
                    kind: sym.kind,
                    exported: sym.exported,
                    range: sym.range,
                    containerName: sym.containerName,
                    dependencies: sym.dependencies
                },
                symbol: sym,
                tokenCount: Math.ceil((sym.signature?.length || sym.name.length) / 4)
            });

            // Edge: file defines symbol
            this.addEdge(fileNodeId, symNodeId, 'defines');

            // Edge: symbol exported by file
            if (sym.exported) {
                this.addEdge(fileNodeId, symNodeId, 'exports');
            }

            // Map lower-case symbol name for quick lookup
            const lowerName = sym.name.toLowerCase();
            const existingNameIds = this.symbolNameToIds.get(lowerName) || [];
            if (!existingNameIds.includes(symNodeId)) {
                this.symbolNameToIds.set(lowerName, [...existingNameIds, symNodeId]);
            }
        }

        // Wire dependency and call edges between symbols
        for (const sym of symbols) {
            if (sym.dependencies && sym.dependencies.length > 0) {
                for (const depName of sym.dependencies) {
                    const targetIds = this.resolveDependencyTargets(depName, cleanPath);
                    for (const targetId of targetIds) {
                        if (targetId !== sym.id) {
                            this.addEdge(sym.id, targetId, 'references');
                        }
                    }
                }
            }
        }

        this.fileToSymbols.set(cleanPath, newSymbolIds);
        this.lastUpdated = Date.now();
        return symbols;
    }

    /**
     * Extract symbols using TypeScript AST Compiler API.
     */
    private extractTypeScriptAstSymbols(filePath: string, content: string): CodeSymbol[] {
        const symbols: CodeSymbol[] = [];
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        const getLineAndCol = (pos: number): { line: number; col: number } => {
            const lc = sourceFile.getLineAndCharacterOfPosition(pos);
            return { line: lc.line + 1, col: lc.character + 1 };
        };

        const getDocstring = (node: ts.Node): string | undefined => {
            const fullText = sourceFile.getFullText();
            const commentRanges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
            if (commentRanges && commentRanges.length > 0) {
                const comment = fullText.slice(commentRanges[0].pos, commentRanges[0].end).trim();
                return comment.replace(/^\/\*\*?|\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim();
            }
            return undefined;
        };

        const isExportedNode = (node: ts.Node): boolean => {
            const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
            if (modifiers) {
                return modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            }
            return false;
        };

        const findDependencies = (node: ts.Node): string[] => {
            const deps = new Set<string>();
            const walk = (n: ts.Node) => {
                if (ts.isIdentifier(n)) {
                    const text = n.text;
                    if (text && text.length > 1 && !['this', 'undefined', 'null', 'true', 'false', 'window', 'document', 'console'].includes(text)) {
                        deps.add(text);
                    }
                }
                ts.forEachChild(n, walk);
            };
            ts.forEachChild(node, walk);
            return Array.from(deps);
        };

        const visit = (node: ts.Node, containerName?: string) => {
            // 1. Function Declaration
            if (ts.isFunctionDeclaration(node) && node.name) {
                const start = getLineAndCol(node.getStart(sourceFile));
                const end = getLineAndCol(node.getEnd());
                const name = node.name.text;
                const sig = node.getText(sourceFile).slice(0, 300).split('{')[0].trim();
                const doc = getDocstring(node);
                const exported = isExportedNode(node);
                const deps = findDependencies(node).filter(d => d !== name);

                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'function',
                    filePath,
                    range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                    signature: sig,
                    docstring: doc,
                    dependencies: deps,
                    exported,
                    containerName,
                    bodySummary: node.getText(sourceFile).slice(0, 400)
                });
            }
            // 2. Class Declaration
            else if (ts.isClassDeclaration(node) && node.name) {
                const start = getLineAndCol(node.getStart(sourceFile));
                const end = getLineAndCol(node.getEnd());
                const name = node.name.text;
                const exported = isExportedNode(node);
                const doc = getDocstring(node);
                const heritage = node.heritageClauses?.map(h => h.getText(sourceFile)).join(' ') || '';
                const sig = `class ${name} ${heritage}`.trim();
                const deps = findDependencies(node).filter(d => d !== name);

                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'class',
                    filePath,
                    range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                    signature: sig,
                    docstring: doc,
                    dependencies: deps,
                    exported,
                    containerName,
                    bodySummary: node.getText(sourceFile).slice(0, 400)
                });

                // Class members (methods and properties)
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && member.name) {
                        const mName = member.name.getText(sourceFile);
                        const mStart = getLineAndCol(member.getStart(sourceFile));
                        const mEnd = getLineAndCol(member.getEnd());
                        const mSig = `${name}.${member.getText(sourceFile).slice(0, 200).split('{')[0].trim()}`;
                        const mDeps = findDependencies(member).filter(d => d !== mName);

                        symbols.push({
                            id: `sym:${filePath}:${name}.${mName}`,
                            name: `${name}.${mName}`,
                            kind: 'method',
                            filePath,
                            range: { startLine: mStart.line, startColumn: mStart.col, endLine: mEnd.line, endColumn: mEnd.col },
                            signature: mSig,
                            docstring: getDocstring(member),
                            dependencies: mDeps,
                            exported,
                            containerName: name,
                            bodySummary: member.getText(sourceFile).slice(0, 300)
                        });
                    }
                }
            }
            // 3. Interface Declaration
            else if (ts.isInterfaceDeclaration(node)) {
                const start = getLineAndCol(node.getStart(sourceFile));
                const end = getLineAndCol(node.getEnd());
                const name = node.name.text;
                const exported = isExportedNode(node);
                const doc = getDocstring(node);
                const heritage = node.heritageClauses?.map(h => h.getText(sourceFile)).join(' ') || '';
                const sig = `interface ${name} ${heritage}`.trim();
                const deps = findDependencies(node).filter(d => d !== name);

                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'interface',
                    filePath,
                    range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                    signature: sig,
                    docstring: doc,
                    dependencies: deps,
                    exported,
                    containerName,
                    bodySummary: node.getText(sourceFile).slice(0, 400)
                });
            }
            // 4. Type Alias Declaration
            else if (ts.isTypeAliasDeclaration(node)) {
                const start = getLineAndCol(node.getStart(sourceFile));
                const end = getLineAndCol(node.getEnd());
                const name = node.name.text;
                const exported = isExportedNode(node);
                const doc = getDocstring(node);
                const sig = node.getText(sourceFile).slice(0, 200).trim();
                const deps = findDependencies(node).filter(d => d !== name);

                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'type',
                    filePath,
                    range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                    signature: sig,
                    docstring: doc,
                    dependencies: deps,
                    exported,
                    containerName,
                    bodySummary: sig
                });
            }
            // 5. Enum Declaration
            else if (ts.isEnumDeclaration(node)) {
                const start = getLineAndCol(node.getStart(sourceFile));
                const end = getLineAndCol(node.getEnd());
                const name = node.name.text;
                const exported = isExportedNode(node);
                const doc = getDocstring(node);
                const sig = `enum ${name}`;

                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'enum',
                    filePath,
                    range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                    signature: sig,
                    docstring: doc,
                    dependencies: [],
                    exported,
                    containerName,
                    bodySummary: node.getText(sourceFile).slice(0, 300)
                });
            }
            // 6. Variable Statement (const / let / var)
            else if (ts.isVariableStatement(node)) {
                const exported = isExportedNode(node);
                const doc = getDocstring(node);

                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        const name = decl.name.text;
                        const start = getLineAndCol(decl.getStart(sourceFile));
                        const end = getLineAndCol(decl.getEnd());
                        const isFunction = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
                        const kind: SymbolKind = isFunction ? 'function' : 'variable';
                        const sig = decl.getText(sourceFile).slice(0, 200).split('=>')[0].trim();
                        const deps = findDependencies(decl).filter(d => d !== name);

                        symbols.push({
                            id: `sym:${filePath}:${name}`,
                            name,
                            kind,
                            filePath,
                            range: { startLine: start.line, startColumn: start.col, endLine: end.line, endColumn: end.col },
                            signature: sig,
                            docstring: doc,
                            dependencies: deps,
                            exported,
                            containerName,
                            bodySummary: decl.getText(sourceFile).slice(0, 300)
                        });
                    }
                }
            }
            // 7. Import Declaration (wire import edges)
            else if (ts.isImportDeclaration(node)) {
                const moduleSpecifier = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
                const fileNodeId = `file:${filePath}`;
                this.addEdge(fileNodeId, `module:${moduleSpecifier}`, 'imports');
            }

            ts.forEachChild(node, n => visit(n, containerName));
        };

        visit(sourceFile);
        return symbols;
    }

    /**
     * Extract symbols for non-TypeScript files (Python, Rust, Go, C++, etc.) using robust scanners.
     */
    private extractMultiLanguageSymbols(filePath: string, content: string, language?: string): CodeSymbol[] {
        const symbols: CodeSymbol[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const lineNo = i + 1;

            // Python def/class
            const pyFuncMatch = trimmed.match(/^def\s+([a-zA-Z_]\w*)\s*\((.*?)\):/);
            if (pyFuncMatch) {
                symbols.push({
                    id: `sym:${filePath}:${pyFuncMatch[1]}`,
                    name: pyFuncMatch[1],
                    kind: 'function',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: `def ${pyFuncMatch[1]}(${pyFuncMatch[2]})`,
                    exported: !pyFuncMatch[1].startsWith('_')
                });
                continue;
            }
            const pyClassMatch = trimmed.match(/^class\s+([a-zA-Z_]\w*)\s*(\(.*?\))?:/);
            if (pyClassMatch) {
                symbols.push({
                    id: `sym:${filePath}:${pyClassMatch[1]}`,
                    name: pyClassMatch[1],
                    kind: 'class',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: `class ${pyClassMatch[1]}${pyClassMatch[2] || ''}`,
                    exported: !pyClassMatch[1].startsWith('_')
                });
                continue;
            }

            // Rust fn, struct, enum, trait
            const rustFnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*(<.*?>)?\s*\((.*?)\)/);
            if (rustFnMatch) {
                symbols.push({
                    id: `sym:${filePath}:${rustFnMatch[1]}`,
                    name: rustFnMatch[1],
                    kind: 'function',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: trimmed.split('{')[0].trim(),
                    exported: trimmed.startsWith('pub ')
                });
                continue;
            }
            const rustStructMatch = trimmed.match(/^(?:pub\s+)?(struct|enum|trait)\s+([a-zA-Z_]\w*)/);
            if (rustStructMatch) {
                symbols.push({
                    id: `sym:${filePath}:${rustStructMatch[2]}`,
                    name: rustStructMatch[2],
                    kind: rustStructMatch[1] === 'enum' ? 'enum' : rustStructMatch[1] === 'trait' ? 'interface' : 'class',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: trimmed.split('{')[0].trim(),
                    exported: trimmed.startsWith('pub ')
                });
                continue;
            }

            // Go func, type struct/interface
            const goFuncMatch = trimmed.match(/^func\s+(?:\(.*?\)\s+)?([a-zA-Z_]\w*)\s*\((.*?)\)/);
            if (goFuncMatch) {
                const name = goFuncMatch[1];
                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: 'function',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: trimmed.split('{')[0].trim(),
                    exported: name[0] === name[0].toUpperCase()
                });
                continue;
            }
            const goTypeMatch = trimmed.match(/^type\s+([a-zA-Z_]\w*)\s+(struct|interface)/);
            if (goTypeMatch) {
                const name = goTypeMatch[1];
                symbols.push({
                    id: `sym:${filePath}:${name}`,
                    name,
                    kind: goTypeMatch[2] === 'interface' ? 'interface' : 'class',
                    filePath,
                    range: { startLine: lineNo, startColumn: 1, endLine: lineNo, endColumn: line.length },
                    signature: `type ${name} ${goTypeMatch[2]}`,
                    exported: name[0] === name[0].toUpperCase()
                });
                continue;
            }
        }

        return symbols;
    }

    /**
     * Index the workspace's own source files. The file list comes from git where the root is a git worktree — the
     * tracked and untracked-but-not-ignored files, so `.gitignore` decides what is this project's source and nothing
     * here has to guess — and from a directory walk otherwise. `maxFiles` is a guard against an unbounded tree, not a
     * sample: a cap low enough to bite leaves the index holding whichever files the enumeration happened to reach
     * first, which is worse than an index that is plainly too small, so the count reached is reported back.
     */
    async indexWorkspaceDirectory(
        workspaceRoot: string,
        options: {
            fileFilter?: (filePath: string) => boolean;
            maxFiles?: number;
            extensions?: string[];
        } = {}
    ): Promise<number> {
        const allowedExts = new Set(options.extensions || INDEXABLE_SOURCE_EXTENSIONS);
        const maxFiles = options.maxFiles || 5000;
        if (!(await fs.pathExists(workspaceRoot))) {
            return 0;
        }

        const admits = (relativePath: string): boolean => {
            if (!allowedExts.has(path.extname(relativePath).toLowerCase())) return false;
            if (relativePath.split('/').some(segment => UNINDEXED_DIRECTORIES.includes(segment))) return false;
            return options.fileFilter ? options.fileFilter(relativePath) : true;
        };

        const candidates = (await this.gitTrackedSourceFiles(workspaceRoot))?.filter(admits)
            ?? await this.walkSourceFiles(workspaceRoot, admits, maxFiles);

        let count = 0;
        for (const relativePath of candidates) {
            if (count >= maxFiles) break;
            try {
                const fullPath = path.join(workspaceRoot, relativePath);
                const stat = await fs.stat(fullPath);
                if (!stat.isFile() || stat.size > MAX_INDEXED_FILE_BYTES) continue;
                this.indexSourceFile(relativePath, await fs.readFile(fullPath, 'utf8'));
                count++;
                if (count % INDEX_YIELD_INTERVAL === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            } catch {
                // Skip unreadable or vanished files safely
            }
        }

        return count;
    }

    /**
     * The workspace's source files according to git: tracked plus untracked-but-not-ignored, workspace-relative.
     * Undefined when the root is not the top of a git worktree or git cannot be run, so the caller walks instead.
     */
    private async gitTrackedSourceFiles(workspaceRoot: string): Promise<string[] | undefined> {
        try {
            const { execFile } = await import('child_process');
            const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
                execFile('git', ['-C', workspaceRoot, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
                    if (err) { reject(err); } else { resolve(stdout); }
                });
            });
            // Only this root's own files: inside a subdirectory of a repository, git would list the whole repository.
            const top = (await run(['rev-parse', '--show-toplevel'])).trim();
            if (!top || path.resolve(top) !== path.resolve(workspaceRoot)) {
                return undefined;
            }
            const listed = await run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
            return listed.split('\0').filter(Boolean);
        } catch {
            return undefined;
        }
    }

    /**
     * Breadth-first walk for a root git does not describe: every directory's files before its subdirectories, so a
     * cap reached early leaves the shallow files (a project's own source) indexed rather than whatever lies deepest
     * down the first branch.
     */
    private async walkSourceFiles(
        workspaceRoot: string,
        admits: (relativePath: string) => boolean,
        maxFiles: number
    ): Promise<string[]> {
        const found: string[] = [];
        const queue: string[] = [workspaceRoot];

        while (queue.length > 0 && found.length < maxFiles) {
            const dir = queue.shift()!;
            let entries: string[];
            try {
                entries = await fs.readdir(dir);
            } catch {
                continue;
            }
            const subdirectories: string[] = [];
            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
                let stat;
                try {
                    stat = await fs.stat(fullPath);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    if (!UNINDEXED_DIRECTORIES.includes(entry)) {
                        subdirectories.push(fullPath);
                    }
                } else if (stat.isFile() && admits(relativePath) && found.length < maxFiles) {
                    found.push(relativePath);
                }
            }
            queue.push(...subdirectories);
        }

        return found;
    }

    // =========================================================================
    // SECTION: Semantic Symbol Graph Retrieval & Relevance Scoring
    // =========================================================================

    /**
     * Retrieves relevant symbols and their dependency subgraphs scored by semantic relevance
     * and graph topological proximity.
     */
    retrieveSymbolGraph(queryOrOptions: string | SymbolGraphQuery): SymbolGraphResult {
        const options: SymbolGraphQuery = typeof queryOrOptions === 'string'
            ? { query: queryOrOptions }
            : queryOrOptions;

        const query = options.query || '';
        const maxSymbols = options.maxSymbols || 15;
        const targetFiles = options.targetFiles ? new Set(options.targetFiles.map(f => f.replace(/\\/g, '/'))) : undefined;
        const minScore = options.minRelevanceScore ?? 0.5;

        // 1 & 2. Relevance scoring and 1-hop graph expansion, from the last pass when this turn already ran it
        const scores = this.scoreSymbolsForQuery(query, targetFiles, options.kinds);

        // 3. Sort and pick top matching symbols
        const sortedEntries = Array.from(scores.entries())
            .filter(e => e[1] >= minScore)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxSymbols);

        const matchingSymbols: CodeSymbol[] = [];
        const subgraphNodes: ContextGraphNode[] = [];
        const referencedFilesSet = new Set<string>();
        const relevanceScoresRecord: Record<string, number> = {};

        const selectedNodeIds = new Set<string>();

        for (const [symId, score] of sortedEntries) {
            const sym = this.symbols.get(symId);
            if (sym) {
                matchingSymbols.push(sym);
                relevanceScoresRecord[sym.name] = Math.round(score * 100) / 100;
                referencedFilesSet.add(sym.filePath);
                selectedNodeIds.add(symId);

                const node = this.nodes.get(symId);
                if (node) {
                    subgraphNodes.push(node);
                }
            }
        }

        // 4. Extract induced subgraph edges
        const subgraphEdges = this.edges.filter(
            e => selectedNodeIds.has(e.sourceId) && selectedNodeIds.has(e.targetId)
        );

        // 5. Synthesize compact prompt context
        const promptLines: string[] = [
            `[CODEBASE_SYMBOLS_BY_WORD_MATCH_AND_ONE_GRAPH_HOP: listed=${matchingSymbols.length} indexed=${this.symbols.size} from_files=${this.fileToSymbols.size}]`
        ];

        for (const sym of matchingSymbols) {
            const docPart = sym.docstring ? ` /* ${sym.docstring.slice(0, 100)} */` : '';
            promptLines.push(`• [${sym.kind.toUpperCase()}] \`${sym.name}\` in \`${sym.filePath}:${sym.range.startLine}\`${docPart}`);
            if (sym.signature) {
                promptLines.push(`    signature: ${sym.signature}`);
            }
            if (sym.dependencies && sym.dependencies.length > 0) {
                promptLines.push(`    dependencies: [${sym.dependencies.slice(0, 6).join(', ')}]`);
            }
        }

        if (subgraphEdges.length > 0) {
            promptLines.push('Relationships:');
            for (const edge of subgraphEdges) {
                const sName = edge.sourceId.split(':').pop();
                const tName = edge.targetId.split(':').pop();
                promptLines.push(`  ${sName} --(${edge.relation})--> ${tName}`);
            }
        }

        const compressedPromptContext = promptLines.join('\n');

        return {
            query,
            matchingSymbols,
            subgraphNodes,
            subgraphEdges,
            relevanceScores: relevanceScoresRecord,
            compressedPromptContext,
            referencedFiles: Array.from(referencedFilesSet),
            totalSymbolsIndexed: this.symbols.size
        };
    }

    /**
     * Score every eligible symbol against the query, then raise each top seed's neighbours. The result depends only
     * on the query, the filters and the index, so it is kept until one of those changes: the same turn asks for it
     * more than once, with a different number of symbols each time, and this is the pass that walks all of them.
     */
    private scoreSymbolsForQuery(
        query: string,
        targetFiles?: Set<string>,
        kinds?: SymbolKind[]
    ): Map<string, number> {
        const key = JSON.stringify([query, targetFiles ? [...targetFiles].sort() : null, kinds ?? null]);
        if (this.lastScoring && this.lastScoring.key === key && this.lastScoring.indexedAt === this.lastUpdated) {
            return this.lastScoring.scores;
        }

        const queryTokens = this.tokenizeQuery(query);
        const scores: Map<string, number> = new Map();

        for (const [symId, sym] of this.symbols.entries()) {
            if (targetFiles && !targetFiles.has(sym.filePath)) {
                continue;
            }
            if (kinds && !kinds.includes(sym.kind)) {
                continue;
            }
            const score = this.calculateSymbolSemanticScore(sym, query, queryTokens);
            if (score > 0) {
                scores.set(symId, score);
            }
        }

        const highScoringIds = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(e => e[0]);

        for (const seedId of highScoringIds) {
            const seedScore = scores.get(seedId) || 0;
            // 1-hop neighbour expansion, over the seed's own adjacency rather than every edge in the graph
            for (const edge of this.outgoing.get(seedId) || []) {
                const targetScore = scores.get(edge.targetId) || 0;
                scores.set(edge.targetId, Math.max(targetScore, seedScore * 0.6));
            }
            for (const edge of this.incoming.get(seedId) || []) {
                const sourceScore = scores.get(edge.sourceId) || 0;
                scores.set(edge.sourceId, Math.max(sourceScore, seedScore * 0.4));
            }
        }

        this.lastScoring = { key, indexedAt: this.lastUpdated, scores };
        return scores;
    }

    /**
     * Compute semantic relevance score for a symbol against user query.
     */
    private calculateSymbolSemanticScore(sym: CodeSymbol, rawQuery: string, tokens: string[]): number {
        let score = 0;
        const lowerName = sym.name.toLowerCase();
        const lowerQuery = rawQuery.toLowerCase();
        // Lowered once per symbol, not once per token: this runs over every indexed symbol on every query, and the
        // repeated case folding of a signature and a body summary was the whole cost of a retrieval.
        const lowerSignature = sym.signature?.toLowerCase();
        const lowerDocstring = sym.docstring?.toLowerCase();
        const lowerPath = sym.filePath.toLowerCase();
        const lowerBody = sym.bodySummary?.toLowerCase();

        // Exact name match, then containment either way — but only for names and queries long enough for
        // containment to mean anything. A symbol named `a`, `h` or `s` is inside almost every question ever asked,
        // and used to score 6.0 for it; an exact match on a short name still scores through the first clause.
        const CONTAINMENT_FLOOR = 3;
        if (lowerName === lowerQuery) {
            score += 10.0;
        } else if (lowerName.length >= CONTAINMENT_FLOOR && !STOP_WORDS.has(lowerName) && containsAtWordBoundary(lowerQuery, lowerName)) {
            // The name written out in the request ("why does roofShadowLift halo"), not merely its letters sitting
            // inside a word of it: "swallow" contains "wall" and "all", and used to rank both as matches.
            score += 6.0;
        } else if (lowerQuery.length >= CONTAINMENT_FLOOR && lowerName.includes(lowerQuery)) {
            // The query inside the name is left as plain containment: identifiers run words together, so
            // `facadeLattice` must still answer "lattice".
            score += 4.0;
        }

        // Sub-token overlap
        for (const token of tokens) {
            if (lowerName === token) {
                score += 3.5;
            } else if (lowerName.includes(token)) {
                score += 2.0;
            }

            if (lowerSignature && lowerSignature.includes(token)) {
                score += 1.5;
            }

            if (lowerDocstring && lowerDocstring.includes(token)) {
                score += 1.0;
            }

            if (lowerPath.includes(token)) {
                score += 1.2;
            }

            if (lowerBody && lowerBody.includes(token)) {
                score += 0.5;
            }
        }

        // Boost exported symbols and classes/interfaces
        if (sym.exported) {
            score *= 1.2;
        }
        if (sym.kind === 'class' || sym.kind === 'interface') {
            score *= 1.1;
        }

        return score;
    }

    /**
     * Break query into semantic search tokens (handles camelCase, PascalCase, snake_case).
     */
    private tokenizeQuery(query: string): string[] {
        const words = query
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_.:#/\\()]/g, ' ')
            .toLowerCase()
            .split(/\s+/)
            // Tokens are tested as substrings of names, paths and bodies, where a two-letter token matches almost
            // everything: "an" and "of" turned any question into a dozen confident-looking matches. Three letters is
            // the floor, and a symbol whose whole name is in the query still scores through the name clauses above.
            .filter(w => w.length > 2 && !STOP_WORDS.has(w));

        return Array.from(new Set(words));
    }

    /**
     * Add a directed relationship edge between two nodes.
     */
    private addEdge(sourceId: string, targetId: string, relation: ContextRelationType, weight: number = 1.0): void {
        const existing = this.outgoing.get(sourceId);
        if (existing && existing.some(e => e.targetId === targetId && e.relation === relation)) {
            return;
        }
        const edge: ContextGraphEdge = { sourceId, targetId, relation, weight };
        this.edges.push(edge);
        const out = existing;
        if (out) { out.push(edge); } else { this.outgoing.set(sourceId, [edge]); }
        const into = this.incoming.get(targetId);
        if (into) { into.push(edge); } else { this.incoming.set(targetId, [edge]); }
    }

    /**
     * A dependency name resolves to the symbols of that name in the same file, else to the repo-wide ones while the
     * name identifies few enough of them to mean anything. A name hundreds of symbols share (`id`, `render`, `path`)
     * resolves to none: an edge to each would say only that the name is common, and would square the graph.
     */
    private resolveDependencyTargets(depName: string, filePath: string): string[] {
        const candidates = this.symbolNameToIds.get(depName.toLowerCase());
        if (!candidates || candidates.length === 0) {
            return [];
        }
        const sameFile = candidates.filter(id => this.symbols.get(id)?.filePath === filePath);
        if (sameFile.length > 0) {
            return sameFile;
        }
        return candidates.length <= AMBIGUOUS_DEPENDENCY_FANOUT ? candidates : [];
    }

    /**
     * Forget everything a file contributed except its file node: its symbols, their nodes and edges, and its entries
     * in the name lookup (which otherwise keeps pointing at symbols that no longer exist).
     */
    private forgetSymbolsOf(cleanPath: string): void {
        const oldSymbolIds = this.fileToSymbols.get(cleanPath) || [];
        if (oldSymbolIds.length === 0) {
            // A file that yielded no symbol still had an entry, and it is still a file this index has read
            this.fileToSymbols.delete(cleanPath);
            return;
        }
        const dropped = new Set(oldSymbolIds);
        for (const symId of oldSymbolIds) {
            const sym = this.symbols.get(symId);
            if (sym) {
                const lowerName = sym.name.toLowerCase();
                const remaining = (this.symbolNameToIds.get(lowerName) || []).filter(id => id !== symId);
                if (remaining.length > 0) {
                    this.symbolNameToIds.set(lowerName, remaining);
                } else {
                    this.symbolNameToIds.delete(lowerName);
                }
            }
            this.nodes.delete(symId);
            this.symbols.delete(symId);
        }
        this.removeEdgesTouching(dropped);
        this.fileToSymbols.delete(cleanPath);
    }

    /**
     * Drop a file from the graph: its symbols and its own file node. Called when a watched file is deleted, so the
     * index does not answer with symbols from a file that is gone.
     */
    removeSourceFile(filePath: string): void {
        const cleanPath = filePath.replace(/\\/g, '/');
        this.forgetSymbolsOf(cleanPath);
        const fileNodeId = `file:${cleanPath}`;
        if (this.nodes.delete(fileNodeId)) {
            this.removeEdgesTouching(new Set([fileNodeId]));
        }
        this.lastUpdated = Date.now();
    }

    /**
     * Drop every edge touching these node ids, from the edge list and both adjacency indexes. Called when a file is
     * re-indexed or removed, so a deleted symbol leaves no edge behind.
     */
    private removeEdgesTouching(nodeIds: Set<string>): void {
        if (nodeIds.size === 0) {
            return;
        }
        const touchedNeighbours = new Set<string>();
        this.edges = this.edges.filter(e => {
            if (!nodeIds.has(e.sourceId) && !nodeIds.has(e.targetId)) {
                return true;
            }
            touchedNeighbours.add(e.sourceId);
            touchedNeighbours.add(e.targetId);
            return false;
        });
        // Rebuild only the adjacency lists that lost an edge.
        for (const id of touchedNeighbours) {
            this.outgoing.delete(id);
            this.incoming.delete(id);
        }
        for (const edge of this.edges) {
            if (touchedNeighbours.has(edge.sourceId)) {
                const out = this.outgoing.get(edge.sourceId);
                if (out) { out.push(edge); } else { this.outgoing.set(edge.sourceId, [edge]); }
            }
            if (touchedNeighbours.has(edge.targetId)) {
                const into = this.incoming.get(edge.targetId);
                if (into) { into.push(edge); } else { this.incoming.set(edge.targetId, [edge]); }
            }
        }
    }

    /**
     * Get the full project context graph.
     */
    getGraph(): ProjectContextGraph {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: [...this.edges],
            lastUpdated: this.lastUpdated
        };
    }

    /**
     * Get all indexed symbols.
     */
    getAllSymbols(): CodeSymbol[] {
        return Array.from(this.symbols.values());
    }

    /**
     * What the index holds: source files parsed and symbols extracted. Reported alongside every search result,
     * because "no match" and "the index does not cover your code" look identical without it.
     */
    getIndexCoverage(): { files: number; symbols: number } {
        return { files: this.fileToSymbols.size, symbols: this.symbols.size };
    }

    /**
     * A slice of the graph around a focus node, or around what the query matches, rendered one line per node and
     * edge. `maxChars` bounds that rendering: it was called `maxTokens` and compared against a character count, so
     * every caller's budget was four times smaller than it read as; the name now says which unit it is, and
     * `maxTokens` is still accepted as the characters it always meant.
     */
    getContextSlice(focusNodeId?: string, options: ContextGraphSliceOptions = {}): ContextGraphSlice {
        const maxChars = options.maxChars ?? options.maxTokens ?? 2000;
        const selectedNodes: ContextGraphNode[] = [];
        const selectedEdges: ContextGraphEdge[] = [];
        let matchedSymbols: CodeSymbol[] | undefined;

        // A query selects the symbols it matches and their subgraph; a focus node selects its neighbourhood below
        if (options.query) {
            const symResult = this.retrieveSymbolGraph({
                query: options.query,
                maxSymbols: 10
            });
            matchedSymbols = symResult.matchingSymbols;
            selectedNodes.push(...symResult.subgraphNodes);
            selectedEdges.push(...symResult.subgraphEdges);
        }

        if (focusNodeId && this.nodes.has(focusNodeId)) {
            const focusNode = this.nodes.get(focusNodeId)!;
            if (!selectedNodes.some(n => n.id === focusNode.id)) {
                selectedNodes.push(focusNode);
            }

            // Find 1-hop and 2-hop neighbor nodes
            const neighborIds = new Set<string>();
            for (const edge of this.edges) {
                if (edge.sourceId === focusNodeId) {
                    neighborIds.add(edge.targetId);
                    selectedEdges.push(edge);
                } else if (edge.targetId === focusNodeId) {
                    neighborIds.add(edge.sourceId);
                    selectedEdges.push(edge);
                }
            }

            for (const nId of neighborIds) {
                const node = this.nodes.get(nId);
                if (node && !selectedNodes.some(n => n.id === node.id)) {
                    selectedNodes.push(node);
                }
            }
        }
        // A query that matched nothing used to fall back to the first twenty nodes in insertion order, which reads
        // as context about the request and is not: it is whatever was indexed first. The slice says so instead, with
        // what the index holds, so a miss can be told from an index that does not cover the code.
        const matchedNothing = selectedNodes.length === 0;

        // Synthesize raw topological context representation
        const rawLines: string[] = [
            `[PROJECT_TOPOLOGICAL_CONTEXT_GRAPH: total_nodes=${this.nodes.size} edges=${this.edges.length}]`
        ];

        for (const n of selectedNodes) {
            rawLines.push(`NODE [${n.type.toUpperCase()}] id=${n.id} title="${n.title}"`);
            if (n.summary) {
                rawLines.push(`  summary: ${n.summary}`);
            }
            if (n.content && n.content.length < 500) {
                rawLines.push(`  content: ${n.content.replace(/\n/g, ' ')}`);
            }
        }

        for (const e of selectedEdges) {
            rawLines.push(`EDGE: ${e.sourceId} --(${e.relation})--> ${e.targetId}`);
        }

        const rawContext = rawLines.join('\n');

        // One line per node and per edge: a title and a summary, with the bodies left behind. This is a shorter
        // rendering of the same slice, not a learned or latent compression of it, whatever it was once called.
        const nodeLines = selectedNodes.map(n => `[${n.type.toUpperCase()}:${n.id}] ${n.title} -> ${n.summary || ''}`);
        const edgeLines = selectedEdges.map(e => `${e.sourceId} --(${e.relation})--> ${e.targetId}`);

        const coverage = this.getIndexCoverage();
        const compactParts: string[] = matchedNothing
            ? [`[PROJECT_CONTEXT_GRAPH_SLICE: nothing in the graph matched this request; ${coverage.symbols} symbols indexed from ${coverage.files} file(s)]`]
            : [
                `[PROJECT_CONTEXT_GRAPH_SLICE: nodes=${selectedNodes.length} edges=${selectedEdges.length} focus=${focusNodeId || 'global'} indexed_files=${coverage.files}]`,
                ...nodeLines,
                ...edgeLines
            ];

        let compressedText = compactParts.join('\n');
        if (compressedText.length > maxChars) {
            compressedText = compressedText.slice(0, maxChars) + '...[TRUNCATED]';
        }

        const rawLength = Math.max(1, rawContext.length);
        const compressionRatio = Math.max(0, 1 - (compressedText.length / rawLength));

        return {
            focusNodeId,
            nodes: selectedNodes,
            edges: selectedEdges,
            compressedPromptContext: compressedText,
            totalTokens: Math.ceil(rawContext.length / 4),
            compressionRatio,
            matchedSymbols
        };
    }

    /**
     * Clear all indexed nodes, edges, and symbols.
     */
    clear(): void {
        this.nodes.clear();
        this.edges = [];
        this.outgoing.clear();
        this.incoming.clear();
        this.symbols.clear();
        this.fileToSymbols.clear();
        this.symbolNameToIds.clear();
        this.lastScoring = undefined;
        this.lastUpdated = Date.now();
    }
}
