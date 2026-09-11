/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Main Canvas Studio & Core Error Boundary
export { GenerativeCanvasStudio } from '../../../extensions/product/src/browser/generative-canvas/GenerativeCanvasStudio';
export { CanvasErrorBoundary } from '../../../extensions/product/src/browser/generative-canvas/CanvasErrorBoundary';

// 7 Custom Visual Canvas Primitives
export { Scene3DPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/Scene3DPrimitive';
export { LiveCodeSandboxPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
export { MarkdownDocumentPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive';
export { KanbanBoardPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/KanbanBoardPrimitive';
export { NodeGraphPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/NodeGraphPrimitive';
export { MetricCardsPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/MetricCardsPrimitive';
export { InteractiveBrowserPrimitive } from '../../../extensions/product/src/browser/generative-canvas/primitives/InteractiveBrowserPrimitive';

// Canvas Types & Protocols
export * from '../../../extensions/product/src/browser/generative-canvas/canvas-types';

// Browser subpath re-export
export * from './browser';

// Common coordinate frames and protocols
export * from './common';
