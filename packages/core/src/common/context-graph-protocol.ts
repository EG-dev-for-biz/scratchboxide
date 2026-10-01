/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type ContextNodeType =
    | 'spec'
    | 'sandbox-file'
    | 'kanban-task'
    | 'node-step'
    | 'workspace-file'
    | 'workflow'
    | 'symbol'
    | 'file'
    | 'module'
    | 'interface'
    | 'class'
    | 'function'
    | 'type';

export type ContextRelationType =
    | 'depends_on'
    | 'implements'
    | 'tests'
    | 'references'
    | 'parent_of'
    | 'imports'
    | 'exports'
    | 'calls'
    | 'extends'
    | 'defines';

export type SymbolKind =
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'variable'
    | 'method'
    | 'property'
    | 'module';

export interface CodeSymbolRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface CodeSymbol {
    id: string;
    name: string;
    kind: SymbolKind;
    filePath: string;
    range: CodeSymbolRange;
    signature?: string;
    docstring?: string;
    dependencies?: string[];
    exported: boolean;
    containerName?: string;
    bodySummary?: string;
}

export interface ContextGraphNode {
    id: string;
    type: ContextNodeType;
    title: string;
    summary: string;
    content?: string;
    path?: string;
    metadata?: Record<string, any>;
    tokenCount?: number;
    symbol?: CodeSymbol;
}

export interface ContextGraphEdge {
    sourceId: string;
    targetId: string;
    relation: ContextRelationType;
    weight?: number;
}

export interface ProjectContextGraph {
    nodes: ContextGraphNode[];
    edges: ContextGraphEdge[];
    lastUpdated: number;
}

export interface ContextGraphSliceOptions {
    maxTokens?: number;
    depth?: number;
    includeTypes?: ContextNodeType[];
    excludeTypes?: ContextNodeType[];
    query?: string;
}

export interface ContextGraphSlice {
    focusNodeId?: string;
    nodes: ContextGraphNode[];
    edges: ContextGraphEdge[];
    compressedPromptContext: string;
    totalTokens: number;
    compressionRatio: number;
    matchedSymbols?: CodeSymbol[];
}

export interface SymbolGraphQuery {
    query: string;
    targetFiles?: string[];
    maxSymbols?: number;
    maxDepth?: number;
    includeDependencies?: boolean;
    kinds?: SymbolKind[];
    minRelevanceScore?: number;
}

export interface SymbolGraphResult {
    query: string;
    matchingSymbols: CodeSymbol[];
    subgraphNodes: ContextGraphNode[];
    subgraphEdges: ContextGraphEdge[];
    relevanceScores: Record<string, number>;
    compressedPromptContext: string;
    referencedFiles: string[];
    totalSymbolsIndexed: number;
}
