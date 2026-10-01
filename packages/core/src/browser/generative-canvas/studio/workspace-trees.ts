/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { FileTreeNode } from '../../../common/workspace-sync-protocol';
export type { FileTreeNode };

export const SCRATCHBOX_TREE: FileTreeNode[] = [
    {
        name: '.cursor',
        path: '.cursor',
        isFolder: true,
        children: [
            { name: 'rules.json', path: '.cursor/rules.json', isFolder: false }
        ]
    },
    {
        name: 'applications',
        path: 'applications',
        isFolder: true,
        children: [
            { name: 'electron-app.ts', path: 'applications/electron-app.ts', isFolder: false },
            { name: 'package.json', path: 'applications/package.json', isFolder: false }
        ]
    },
    {
        name: 'extensions',
        path: 'extensions',
        isFolder: true,
        children: [
            {
                name: 'product',
                path: 'extensions/product',
                isFolder: true,
                children: [
                    {
                        name: 'src',
                        path: 'extensions/product/src',
                        isFolder: true,
                        children: [
                            {
                                name: 'browser',
                                path: 'extensions/product/src/browser',
                                isFolder: true,
                                children: [
                                    {
                                        name: 'generative-canvas',
                                        path: 'extensions/product/src/browser/generative-canvas',
                                        isFolder: true,
                                        children: [
                                            {
                                                name: 'primitives',
                                                path: 'extensions/product/src/browser/generative-canvas/primitives',
                                                isFolder: true,
                                                children: [
                                                    { name: 'LiveCodeSandboxPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx', isFolder: false },
                                                    { name: 'MarkdownDocumentPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx', isFolder: false },
                                                    { name: 'KanbanBoardPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx', isFolder: false },
                                                    { name: 'NodeGraphPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx', isFolder: false },
                                                    { name: 'Scene3DPrimitive.tsx', path: 'extensions/product/src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx', isFolder: false }
                                                ]
                                            },
                                            { name: 'GenerativeCanvasStudio.tsx', path: 'extensions/product/src/browser/generative-canvas/GenerativeCanvasStudio.tsx', isFolder: false },
                                            { name: 'canvas-types.ts', path: 'extensions/product/src/browser/generative-canvas/canvas-types.ts', isFolder: false },
                                            { name: 'unified-ui.css', path: 'extensions/product/src/browser/generative-canvas/unified-ui.css', isFolder: false }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    },
    { name: 'package.json', path: 'package.json', isFolder: false },
    { name: 'tsconfig.json', path: 'tsconfig.json', isFolder: false }
];

export const POSE_3D_TREE: FileTreeNode[] = [
    {
        name: '.cursor',
        path: '.cursor',
        isFolder: true,
        children: [
            { name: 'rules.json', path: '.cursor/rules.json', isFolder: false }
        ]
    },
    {
        name: 'dist',
        path: 'dist',
        isFolder: true,
        children: [
            { name: 'index.html', path: 'dist/index.html', isFolder: false },
            { name: 'main.js', path: 'dist/main.js', isFolder: false }
        ]
    },
    {
        name: 'mcp',
        path: 'mcp',
        isFolder: true,
        children: [
            { name: 'mcp-config.json', path: 'mcp/mcp-config.json', isFolder: false }
        ]
    },
    {
        name: 'node_modules',
        path: 'node_modules',
        isFolder: true,
        children: [
            { name: 'three.js', path: 'node_modules/three.js', isFolder: false }
        ]
    },
    {
        name: 'public',
        path: 'public',
        isFolder: true,
        children: [
            { name: 'favicon.ico', path: 'public/favicon.ico', isFolder: false }
        ]
    },
    {
        name: 'screenshots',
        path: 'screenshots',
        isFolder: true,
        children: [
            { name: 'pose_diagram.png', path: 'screenshots/pose_diagram.png', isFolder: false }
        ]
    },
    {
        name: 'scripts',
        path: 'scripts',
        isFolder: true,
        children: [
            { name: 'deploy.sh', path: 'scripts/deploy.sh', isFolder: false }
        ]
    },
    {
        name: 'src',
        path: 'src',
        isFolder: true,
        children: [
            {
                name: 'assets',
                path: 'src/assets',
                isFolder: true,
                children: [
                    { name: 'anatomy_atlas.png', path: 'src/assets/anatomy_atlas.png', isFolder: false }
                ]
            },
            {
                name: 'components',
                path: 'src/components',
                isFolder: true,
                children: [
                    { name: 'AnatomicalBodyDiagram.tsx', path: 'src/components/AnatomicalBodyDiagram.tsx', isFolder: false },
                    { name: 'AnimationEngine.ts', path: 'src/components/AnimationEngine.ts', isFolder: false },
                    { name: 'AnimationTimeline.tsx', path: 'src/components/AnimationTimeline.tsx', isFolder: false },
                    { name: 'AnimationTypes.ts', path: 'src/components/AnimationTypes.ts', isFolder: false },
                    { name: 'CameraPresets.ts', path: 'src/components/CameraPresets.ts', isFolder: false },
                    { name: 'ComicExporterEngine.ts', path: 'src/components/ComicExporterEngine.ts', isFolder: false },
                    { name: 'ComicExporterModal.tsx', path: 'src/components/ComicExporterModal.tsx', isFolder: false },
                    { name: 'CompositionGuidesEngine.ts', path: 'src/components/CompositionGuidesEngine.ts', isFolder: false },
                    { name: 'CompositionGuidesOverlay.tsx', path: 'src/components/CompositionGuidesOverlay.tsx', isFolder: false },
                    { name: 'CompositionGuidesTypes.ts', path: 'src/components/CompositionGuidesTypes.ts', isFolder: false },
                    { name: 'ControlNetSkeletonEngine.ts', path: 'src/components/ControlNetSkeletonEngine.ts', isFolder: false },
                    { name: 'DirectorExportModal.tsx', path: 'src/components/DirectorExportModal.tsx', isFolder: false },
                    { name: 'DirectorFramingOverlay.tsx', path: 'src/components/DirectorFramingOverlay.tsx', isFolder: false },
                    { name: 'DrawingCanvas.tsx', path: 'src/components/DrawingCanvas.tsx', isFolder: false },
                    { name: 'DrawingEngine.ts', path: 'src/components/DrawingEngine.ts', isFolder: false }
                ]
            }
        ]
    }
];
