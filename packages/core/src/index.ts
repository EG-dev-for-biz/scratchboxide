/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Main Canvas Studio & Core Error Boundary
export { GenerativeCanvasStudio } from './browser/generative-canvas/GenerativeCanvasStudio';
export { CanvasErrorBoundary } from './browser/generative-canvas/CanvasErrorBoundary';

// 7 Custom Visual Canvas Primitives
export { Scene3DPrimitive } from './browser/generative-canvas/primitives/Scene3DPrimitive';
export { LiveCodeSandboxPrimitive } from './browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
export { MarkdownDocumentPrimitive } from './browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
export { KanbanBoardPrimitive } from './browser/generative-canvas/primitives/KanbanBoardPrimitive';
export { NodeGraphPrimitive } from './browser/generative-canvas/primitives/NodeGraphPrimitive';
export { MetricCardsPrimitive } from './browser/generative-canvas/primitives/MetricCardsPrimitive';
export { InteractiveBrowserPrimitive } from './browser/generative-canvas/primitives/InteractiveBrowserPrimitive';

// Canvas Types & Protocols
export * from './browser/generative-canvas/canvas-types';

// Browser subpath re-export
export * from './browser';

// Common coordinate frames and protocols
export * from './common';
