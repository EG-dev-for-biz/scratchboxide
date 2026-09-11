/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { MindMapData, MindMapNode } from '../canvas-types';

export interface MindMapPrimitiveProps {
    data: MindMapData;
    onUpdate?: (updatedData: MindMapData) => void;
}

export const MindMapPrimitive: React.FC<MindMapPrimitiveProps> = ({ data, onUpdate }) => {
    const [mindMap, setMindMap] = React.useState<MindMapData>(data);
    const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(data.root.id);
    const [collapsedNodeIds, setCollapsedNodeIds] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        setMindMap(data);
    }, [data]);

    const toggleCollapse = (nodeId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setCollapsedNodeIds(prev => {
            const next = new Set(prev);
            if (next.has(nodeId)) {
                next.delete(nodeId);
            } else {
                next.add(nodeId);
            }
            return next;
        });
    };

    const handleAddChildNode = (parentId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const newChild: MindMapNode = {
            id: `node-${Date.now()}`,
            label: 'New Idea',
            description: 'Click to add notes',
            color: 'blue'
        };

        const updateNodeTree = (curr: MindMapNode): MindMapNode => {
            if (curr.id === parentId) {
                return {
                    ...curr,
                    children: [...(curr.children || []), newChild]
                };
            }
            if (curr.children) {
                return {
                    ...curr,
                    children: curr.children.map(child => updateNodeTree(child))
                };
            }
            return curr;
        };

        const updatedRoot = updateNodeTree(mindMap.root);
        const updatedMap = { ...mindMap, root: updatedRoot };
        setMindMap(updatedMap);
        setSelectedNodeId(newChild.id);
        if (onUpdate) {
            onUpdate(updatedMap);
        }
    };

    const renderNode = (node: MindMapNode, level: number = 0): React.ReactNode => {
        const hasChildren = node.children && node.children.length > 0;
        const isCollapsed = collapsedNodeIds.has(node.id);
        const isSelected = selectedNodeId === node.id;
        const accent = node.color || (level === 0 ? 'purple' : level === 1 ? 'blue' : 'indigo');

        return (
            <div key={node.id} className={`sb-mindmap-branch level-${level}`}>
                <div
                    className={`sb-mindmap-node sb-accent-${accent} ${isSelected ? 'sb-node-selected' : ''}`}
                    onClick={() => setSelectedNodeId(node.id)}
                >
                    <div className="sb-node-header">
                        {node.icon && <span className="sb-node-icon">{node.icon}</span>}
                        <span className="sb-node-label">{node.label}</span>
                        {node.badge && <span className="sb-node-badge">{node.badge}</span>}
                    </div>

                    {node.description && (
                        <p className="sb-node-desc">{node.description}</p>
                    )}

                    <div className="sb-node-toolbar">
                        {hasChildren && (
                            <button
                                className="sb-node-collapse-btn"
                                onClick={e => toggleCollapse(node.id, e)}
                                title={isCollapsed ? 'Expand branch' : 'Collapse branch'}
                            >
                                {isCollapsed ? `+ (${node.children!.length})` : '−'}
                            </button>
                        )}
                        <button
                            className="sb-node-add-btn"
                            onClick={e => handleAddChildNode(node.id, e)}
                            title="Add sub-topic"
                        >
                            +
                        </button>
                    </div>
                </div>

                {hasChildren && !isCollapsed && (
                    <div className="sb-mindmap-children">
                        {node.children!.map(child => renderNode(child, level + 1))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="sb-primitive-mindmap">
            <div className="sb-primitive-header">
                <div>
                    <h3 className="sb-primitive-title">{mindMap.title}</h3>
                    {mindMap.subtitle && <p className="sb-primitive-subtitle">{mindMap.subtitle}</p>}
                </div>
            </div>

            <div className="sb-mindmap-canvas">
                <div className="sb-mindmap-tree-root">
                    {renderNode(mindMap.root, 0)}
                </div>
            </div>
        </div>
    );
};
