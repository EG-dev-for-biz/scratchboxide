/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
export class ProjectContextGraphService {
    private nodes: Map<string, ContextGraphNode> = new Map();
    private edges: ContextGraphEdge[] = [];
    private symbols: Map<string, CodeSymbol> = new Map();
    private fileToSymbols: Map<string, string[]> = new Map(); // filePath -> symbolId[]
    private symbolNameToIds: Map<string, string[]> = new Map(); // symbolName.toLowerCase() -> symbolId[]
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
        const oldSymbolIds = this.fileToSymbols.get(cleanPath) || [];
        for (const symId of oldSymbolIds) {
            this.nodes.delete(symId);
            this.symbols.delete(symId);
            this.edges = this.edges.filter(e => e.sourceId !== symId && e.targetId !== symId);
        }

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
                    const targetIds = this.symbolNameToIds.get(depName.toLowerCase()) || [];
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
     * Recursively index all source code files across a workspace directory.
     */
    async indexWorkspaceDirectory(
        workspaceRoot: string,
        options: {
            fileFilter?: (filePath: string) => boolean;
            maxFiles?: number;
            extensions?: string[];
        } = {}
    ): Promise<number> {
        const allowedExts = new Set(options.extensions || ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h', '.hpp', '.css', '.json']);
        const maxFiles = options.maxFiles || 200;
        let count = 0;

        const walk = async (dir: string): Promise<void> => {
            if (count >= maxFiles) return;
            const entries = await fs.readdir(dir);

            for (const entry of entries) {
                if (count >= maxFiles) break;
                const fullPath = path.join(dir, entry);
                const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');

                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    if (['node_modules', '.git', 'dist', 'lib', 'build', '.cache', '.turbo', '.next'].includes(entry)) {
                        continue;
                    }
                    await walk(fullPath);
                } else if (stat.isFile()) {
                    const ext = path.extname(entry).toLowerCase();
                    if (!allowedExts.has(ext)) continue;
                    if (options.fileFilter && !options.fileFilter(relativePath)) continue;

                    try {
                        const content = await fs.readFile(fullPath, 'utf8');
                        this.indexSourceFile(relativePath, content);
                        count++;
                    } catch {
                        // Skip unreadable files safely
                    }
                }
            }
        };

        if (await fs.pathExists(workspaceRoot)) {
            await walk(workspaceRoot);
        }

        return count;
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

        // Tokenize query
        const queryTokens = this.tokenizeQuery(query);
        const scores: Map<string, number> = new Map();

        // 1. Semantic Relevance Scoring
        for (const [symId, sym] of this.symbols.entries()) {
            if (targetFiles && !targetFiles.has(sym.filePath)) {
                continue;
            }
            if (options.kinds && !options.kinds.includes(sym.kind)) {
                continue;
            }

            const score = this.calculateSymbolSemanticScore(sym, query, queryTokens);
            if (score > 0) {
                scores.set(symId, score);
            }
        }

        // 2. Graph Topological Proximity & Centrality Boost
        const highScoringIds = Array.from(scores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(e => e[0]);

        for (const seedId of highScoringIds) {
            const seedScore = scores.get(seedId) || 0;
            // 1-hop neighbor expansion
            for (const edge of this.edges) {
                if (edge.sourceId === seedId) {
                    const targetScore = scores.get(edge.targetId) || 0;
                    scores.set(edge.targetId, Math.max(targetScore, seedScore * 0.6));
                } else if (edge.targetId === seedId) {
                    const sourceScore = scores.get(edge.sourceId) || 0;
                    scores.set(edge.sourceId, Math.max(sourceScore, seedScore * 0.4));
                }
            }
        }

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
            `[SEMANTIC_CODEBASE_SYMBOL_GRAPH: matched=${matchingSymbols.length} indexed=${this.symbols.size}]`
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
     * Compute semantic relevance score for a symbol against user query.
     */
    private calculateSymbolSemanticScore(sym: CodeSymbol, rawQuery: string, tokens: string[]): number {
        let score = 0;
        const lowerName = sym.name.toLowerCase();
        const lowerQuery = rawQuery.toLowerCase();

        // Exact name match
        if (lowerName === lowerQuery) {
            score += 10.0;
        } else if (lowerQuery.includes(lowerName)) {
            score += 6.0;
        } else if (lowerName.includes(lowerQuery)) {
            score += 4.0;
        }

        // Sub-token overlap
        for (const token of tokens) {
            if (lowerName === token) {
                score += 3.5;
            } else if (lowerName.includes(token)) {
                score += 2.0;
            }

            if (sym.signature && sym.signature.toLowerCase().includes(token)) {
                score += 1.5;
            }

            if (sym.docstring && sym.docstring.toLowerCase().includes(token)) {
                score += 1.0;
            }

            if (sym.filePath.toLowerCase().includes(token)) {
                score += 1.2;
            }

            if (sym.bodySummary && sym.bodySummary.toLowerCase().includes(token)) {
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
            .filter(w => w.length > 1 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'using', 'get', 'set'].includes(w));

        return Array.from(new Set(words));
    }

    /**
     * Add a directed relationship edge between two nodes.
     */
    private addEdge(sourceId: string, targetId: string, relation: ContextRelationType, weight: number = 1.0): void {
        const exists = this.edges.some(e => e.sourceId === sourceId && e.targetId === targetId && e.relation === relation);
        if (!exists) {
            this.edges.push({ sourceId, targetId, relation, weight });
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
     * Extracts a topological context slice centered around a focus node or all active nodes,
     * and compacts it via MLA compression for token-efficient reasoning with Gemini 3.7 Flash.
     */
    getContextSlice(focusNodeId?: string, options: ContextGraphSliceOptions = {}): ContextGraphSlice {
        const maxTokens = options.maxTokens || 2000;
        const selectedNodes: ContextGraphNode[] = [];
        const selectedEdges: ContextGraphEdge[] = [];
        let matchedSymbols: CodeSymbol[] | undefined;

        // If query provided, use semantic symbol retrieval
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
        } else if (selectedNodes.length === 0) {
            // Select top nodes up to limit
            selectedNodes.push(...Array.from(this.nodes.values()).slice(0, 20));
            selectedEdges.push(...this.edges.slice(0, 30));
        }

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

        // Apply Multi-Head Latent (MLA) context compaction for topological graphs
        const nodeAnchors = selectedNodes.map(n => `[${n.type.toUpperCase()}:${n.id}] ${n.title} -> ${n.summary || ''}`);
        const edgeAnchors = selectedEdges.map(e => `${e.sourceId} --(${e.relation})--> ${e.targetId}`);

        const latentParts: string[] = [
            `[MLA_LATENT_CONTEXT_GRAPH_STATE: nodes=${selectedNodes.length} edges=${selectedEdges.length} focus=${focusNodeId || 'global'}]`,
            ...nodeAnchors,
            ...edgeAnchors
        ];

        let compressedText = latentParts.join('\n');
        if (compressedText.length > maxTokens) {
            compressedText = compressedText.slice(0, maxTokens) + '...[TRUNCATED]';
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
        this.symbols.clear();
        this.fileToSymbols.clear();
        this.symbolNameToIds.clear();
        this.lastUpdated = Date.now();
    }
}
