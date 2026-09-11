/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { Icon3D, IconAutomations, IconChevronDown, IconChevronRight, IconCode, IconCustomize, IconDocument, IconFolder, IconKanban } from '../canvas-icons';
import { FileTreeNode } from './workspace-trees';

export interface WorkspaceFileTreeProps {
    nodes: FileTreeNode[];
    onFileClick: (filePath: string, fileName: string) => void;
}

export function getFileIconByExtension(name: string): React.ReactNode {
    const ext = name.split('.').pop() || '';
    switch (ext) {
        case 'tsx':
        case 'ts':
        case 'js':
            return <IconCode size={11} className="text-blue-400" />;
        case 'css':
            return <IconCustomize size={11} className="text-teal-400" />;
        case 'md':
            return <IconDocument size={11} className="text-amber-400" />;
        case 'json':
            return <IconKanban size={11} className="text-purple-400" />;
        case 'automation':
            return <IconAutomations size={11} className="text-emerald-400" />;
        case '3d':
            return <Icon3D size={11} className="text-rose-400" />;
        default:
            return <IconDocument size={11} className="text-zinc-400" />;
    }
};

/** Collapsible, draggable explorer tree for the active workspace. Owns its folder-collapse state. */
export const WorkspaceFileTree: React.FC<WorkspaceFileTreeProps> = ({ nodes, onFileClick }) => {
    const [collapsedFolders, setCollapsedFolders] = React.useState<Record<string, boolean>>({});

const toggleFolderCollapse = (folderPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedFolders(prev => ({
        ...prev,
        [folderPath]: !prev[folderPath]
    }));
};

const handleDragStart = (e: React.DragEvent, node: FileTreeNode) => {
    const lastDot = node.name.lastIndexOf('.');
    const extension = lastDot !== -1 ? node.name.substring(lastDot) : '';
    const payload = {
        type: 'file_node',
        path: node.path,
        name: node.name,
        extension: extension
    };
    e.dataTransfer.effectAllowed = 'copy';
    const jsonStr = JSON.stringify(payload);
    e.dataTransfer.setData('application/json', jsonStr);
    e.dataTransfer.setData('text/plain', jsonStr);
};

const renderFileTree = (nodes: FileTreeNode[], depth: number = 0): React.ReactNode => {
    return nodes.map(node => {
        const isFolder = node.isFolder;
        const isCollapsed = !!collapsedFolders[node.path];
        const hasChildren = node.children && node.children.length > 0;
        const paddingLeft = `${(depth * 12) + 16}px`;

        return (
            <div key={node.path} className="sb-file-tree-node-wrapper">
                <div
                    className={`sb-file-tree-node ${isFolder ? 'sb-file-tree-folder' : 'sb-file-tree-file'}`}
                    style={{ paddingLeft }}
                    draggable={!isFolder}
                    onDragStart={!isFolder ? (e) => handleDragStart(e, node) : undefined}
                    onClick={(e) => {
                        if (isFolder) {
                            toggleFolderCollapse(node.path, e);
                        } else {
                            onFileClick(node.path, node.name);
                        }
                    }}
                >
                    <div className="sb-file-tree-node-left">
                        {isFolder ? (
                            <span className="sb-file-tree-chevron">
                                {isCollapsed ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                            </span>
                        ) : (
                            <span className="sb-file-tree-bullet-placeholder" />
                        )}
                        
                        {isFolder ? (
                            <IconFolder size={12} className={isCollapsed ? "text-zinc-500" : "text-zinc-400"} />
                        ) : (
                            <span className="sb-file-tree-icon">
                                {getFileIconByExtension(node.name)}
                            </span>
                        )}
                        
                        <span className="sb-file-tree-name" title={node.name}>
                            {node.name}
                        </span>
                    </div>
                </div>
                
                {isFolder && !isCollapsed && hasChildren && (
                    <div className="sb-file-tree-children">
                        {renderFileTree(node.children!, depth + 1)}
                    </div>
                )}
            </div>
        );
    });
};

    return <>{renderFileTree(nodes)}</>;
};
