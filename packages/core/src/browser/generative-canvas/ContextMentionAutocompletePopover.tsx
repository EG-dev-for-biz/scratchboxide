/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { McpServerItem } from './canvas-types';
import {
    ContextMentionCategory,
    ContextMentionItem,
    CONTEXT_MENTION_METADATA,
    resolveContextMentionQuery
} from './context-mention-engine';

export interface ContextMentionAutocompletePopoverProps {
    isOpen: boolean;
    activeCategory: ContextMentionCategory;
    onCategoryChange: (category: ContextMentionCategory) => void;
    query: string;
    selectedIndex: number;
    workspaceFiles?: string[];
    gitStatus?: { branch?: string; modified?: string[]; staged?: string[]; untracked?: string[] } | any;
    mcpServers?: McpServerItem[];
    onSelectMention: (item: ContextMentionItem) => void;
    onClose: () => void;
    positionStyle?: React.CSSProperties;
    width?: string;
    maxHeight?: string;
}

export const ContextMentionAutocompletePopover: React.FC<ContextMentionAutocompletePopoverProps> = ({
    isOpen,
    activeCategory,
    onCategoryChange,
    query,
    selectedIndex,
    workspaceFiles,
    gitStatus,
    mcpServers,
    onSelectMention,
    onClose,
    positionStyle,
    width = '100%',
    maxHeight = '240px'
}) => {
    if (!isOpen) {
        return null;
    }

    const defaultFiles = [
        'src/App.tsx',
        'src/styles.css',
        'package.json',
        'applications/browser/package.json',
        'extensions/product/src/node/gemini-service.ts'
    ];

    const resolvedItems = resolveContextMentionQuery(
        activeCategory,
        query,
        workspaceFiles && workspaceFiles.length > 0 ? workspaceFiles : defaultFiles,
        gitStatus,
        mcpServers
    );

    const categories: ContextMentionCategory[] = ['file', 'folder', 'git', 'terminal', 'web', 'docs', 'mcp'];

    return (
        <div
            className="sb-composer-autocomplete-popover animate-popover"
            style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                width,
                marginBottom: '8px',
                zIndex: 100,
                background: '#18181b',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '12px',
                boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                overflow: 'hidden',
                ...positionStyle
            }}
        >
            <div
                className="sb-autocomplete-header"
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    fontSize: '11px',
                    color: '#a1a1aa'
                }}
            >
                <span>Select Context Reference (@)</span>
                <span style={{ cursor: 'pointer' }} onClick={onClose}>
                    Esc to dismiss
                </span>
            </div>

            <div
                style={{
                    display: 'flex',
                    gap: '4px',
                    padding: '6px 8px',
                    background: '#09090b',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    overflowX: 'auto'
                }}
            >
                {categories.map(cat => (
                    <button
                        key={cat}
                        type="button"
                        className={`sb-segment-btn ${activeCategory === cat ? 'sb-segment-active' : ''}`}
                        style={{ padding: '3px 8px', fontSize: '10px', borderRadius: '6px' }}
                        onClick={() => onCategoryChange(cat)}
                    >
                        {CONTEXT_MENTION_METADATA[cat]?.icon} @{cat}
                    </button>
                ))}
            </div>

            <div className="sb-autocomplete-list" style={{ maxHeight, overflowY: 'auto', padding: '4px' }}>
                {resolvedItems.length === 0 ? (
                    <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: '#71717a' }}>
                        No matching context references found
                    </div>
                ) : (
                    resolvedItems.map((item, idx) => {
                        const isSelected = idx === selectedIndex;
                        return (
                            <div
                                key={item.id}
                                className={`sb-autocomplete-item ${isSelected ? 'sb-autocomplete-item-selected' : ''}`}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '8px 10px',
                                    borderRadius: '8px',
                                    cursor: 'pointer',
                                    fontSize: '12px',
                                    background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                                    border: isSelected ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid transparent'
                                }}
                                onClick={() => onSelectMention(item)}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span>{item.icon || '📄'}</span>
                                    <div>
                                        <div style={{ fontWeight: 500, color: '#f4f4f5' }}>{item.name}</div>
                                        <div style={{ fontSize: '10px', color: '#71717a' }}>{item.description}</div>
                                    </div>
                                </div>
                                <span
                                    style={{
                                        fontSize: '10px',
                                        color: '#60a5fa',
                                        background: 'rgba(59,130,246,0.1)',
                                        padding: '2px 6px',
                                        borderRadius: '4px'
                                    }}
                                >
                                    @{item.type}
                                </span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
