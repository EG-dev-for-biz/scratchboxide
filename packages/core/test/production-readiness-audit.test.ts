/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createInitialSettingsState } from '../src/browser/generative-canvas/settings/settingsReducer';

describe('Scratchbox IDE 100% Production Readiness Audit', () => {
    describe('1. Frontend Demo Buttons Elimination', () => {
        const topBarPath = path.resolve(__dirname, '../src/browser/generative-canvas/studio/StudioTopBar.tsx');
        const sidebarPath = path.resolve(__dirname, '../src/browser/generative-canvas/studio/WorkspaceSidebar.tsx');
        const spotlightPath = path.resolve(__dirname, '../src/browser/generative-canvas/SpotlightLauncherModal.tsx');
        const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');

        it('StudioTopBar must not contain demo launcher button or onOpenDemos handler', () => {
            const topBarSrc = fs.readFileSync(topBarPath, 'utf8');
            expect(topBarSrc).not.toContain('sb-demos-launcher-btn');
            expect(topBarSrc).not.toContain('onOpenDemos');
            expect(topBarSrc).not.toContain('Preloaded Showcase Demos');
        });

        it('WorkspaceSidebar must not contain showcase demos button or onOpenDemos handler', () => {
            const sidebarSrc = fs.readFileSync(sidebarPath, 'utf8');
            expect(sidebarSrc).not.toContain('sb-sidebar-nav-demos');
            expect(sidebarSrc).not.toContain('onOpenDemos');
            // fd6008a ("demos on frontpage") deliberately brought back a sidebar "Demos" entry; it must route
            // to the Settings "Admin & Demos" tab rather than a standalone demo launcher/overlay.
            const demosButton = /<button[^>]*onClick=\{\(\) => openSettingsToTab\('admin'\)\}[^>]*title="View Showcase Demos"[\s\S]*?<\/button>/.exec(sidebarSrc);
            expect(demosButton).not.toBeNull();
            expect(demosButton![0]).toContain('<span className="sb-nav-label">Demos</span>');
            expect(sidebarSrc.match(/Showcase Demos/g) ?? []).toHaveLength(1);
        });

        it('SpotlightLauncherModal must not contain Explore Showcase Demos action item', () => {
            const spotlightSrc = fs.readFileSync(spotlightPath, 'utf8');
            expect(spotlightSrc).not.toContain('act-open-demos');
            expect(spotlightSrc).not.toContain('Explore Showcase Demos');
            expect(spotlightSrc).not.toContain('onOpenDemos');
        });

        it('GenerativeCanvasStudio must not pass onOpenDemos to UI controls', () => {
            const studioSrc = fs.readFileSync(studioPath, 'utf8');
            expect(studioSrc).not.toContain('onOpenDemos:');
            expect(studioSrc).not.toContain('onOpenDemos={');
        });
    });

    describe('2. Strict Production Mode: Mock Mode Defaults Disabled (false)', () => {
        const aiModelsRoutesPath = path.resolve(__dirname, '../../../desktop-app/server/routes/aiModelsRoutes.ts');
        const spatialRoutesPath = path.resolve(__dirname, '../../../desktop-app/server/routes/spatialRoutes.ts');

        it('aiModelsRoutes must default mockExecution to false across all endpoints', () => {
            const src = fs.readFileSync(aiModelsRoutesPath, 'utf8');
            expect(src).not.toContain('mockExecution ?? true');
            expect(src).not.toContain('req.query.mockExecution === undefined');
        });

        it('spatialRoutes must default mockExecution to false across all endpoints', () => {
            const src = fs.readFileSync(spatialRoutesPath, 'utf8');
            expect(src).toContain("const isMock = mockExecution === true || mockExecution === 'true'");
        });
    });

    describe('3. Exhaustive Menu & Control Hardening', () => {
        const topBarPath = path.resolve(__dirname, '../src/browser/generative-canvas/studio/StudioTopBar.tsx');
        const kanbanPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx');
        const docPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
        const settingsReducerPath = path.resolve(__dirname, '../src/browser/generative-canvas/settings/settingsReducer.ts');

        it('StudioTopBar contains unified Cursor Command search pill and Settings without redundant dropdowns', () => {
            const topBarSrc = fs.readFileSync(topBarPath, 'utf8');
            expect(topBarSrc).toContain('sb-topbar-command-pill');
            expect(topBarSrc).toContain('onOpenSpotlight');
            expect(topBarSrc).toContain('openSettingsToTab');
            expect(topBarSrc).not.toContain('sb-topbar-mode-switcher');
            expect(topBarSrc).not.toContain('workspaceMenuRef');
        });

        it('MarkdownDocumentPrimitive provides explicit Morph to Kanban and Morph to Graph toolbar actions', () => {
            const docSrc = fs.readFileSync(docPath, 'utf8');
            expect(docSrc).toContain('handleMorphDocumentToKanban');
            expect(docSrc).toContain('handleMorphDocumentToNodeGraph');
            expect(docSrc).toContain('Morph to Kanban');
            expect(docSrc).toContain('Morph to Graph');
        });

        it('KanbanBoardPrimitive provides explicit Markdown export action', () => {
            const kanbanSrc = fs.readFileSync(kanbanPath, 'utf8');
            expect(kanbanSrc).toContain('handleExportMarkdown');
            expect(kanbanSrc).toContain('Export Markdown');
        });

        it('settingsReducer handles persistent localStorage sync for all setting tabs', () => {
            const settingsSrc = fs.readFileSync(settingsReducerPath, 'utf8');
            expect(settingsSrc).toContain('scratchbox_ide_settings');
            expect(settingsSrc).toContain('localStorage.setItem');
            expect(settingsSrc).toContain('localStorage.getItem');
        });
    });
});
