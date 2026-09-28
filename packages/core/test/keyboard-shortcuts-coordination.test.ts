/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Cursor-Grade Keyboard Shortcuts & Desktop Coordination Architecture', () => {
    const studioPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const shortcutsTabPath = path.resolve(__dirname, '../src/browser/generative-canvas/settings/tabs/ShortcutsTab.tsx');
    const spotlightPath = path.resolve(__dirname, '../src/browser/generative-canvas/SpotlightLauncherModal.tsx');
    const studioSrc = fs.readFileSync(studioPath, 'utf8');
    const shortcutsSrc = fs.readFileSync(shortcutsTabPath, 'utf8');
    const spotlightSrc = fs.readFileSync(spotlightPath, 'utf8');

    it('implements standard ⌘P / ⌘K Spotlight and Command Palette shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'k' || keyLower === 'p'");
        expect(studioSrc).toContain("modalManagerRef.current.isModalOpen('spotlight')");
        expect(shortcutsSrc).toContain('⌘P / ⌘K');
        expect(spotlightSrc).toContain('⌘P / ⌘K');
    });

    it('implements ⌘B primary sidebar toggle shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'b'");
        expect(studioSrc).toContain('setIsSidebarOpen(prev => !prev)');
        expect(shortcutsSrc).toContain('⌘B');
    });

    it('implements ⌘L / ⌘J composer focus shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'l' || keyLower === 'j'");
        expect(studioSrc).toContain('inputRef.current?.focus()');
        expect(shortcutsSrc).toContain('⌘L / ⌘J');
    });

    it('implements ⌘N new conversation shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'n' && !e.shiftKey");
        expect(studioSrc).toContain('handleNewChat()');
        expect(shortcutsSrc).toContain('⌘N');
    });

    it('implements ⌘W close active canvas tab shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'w' && !e.shiftKey");
        expect(studioSrc).toContain('handleCloseArtifactTab');
        expect(shortcutsSrc).toContain('⌘W');
    });

    it('implements ⌘\\ split view toggle shortcut', () => {
        expect(studioSrc).toContain("e.key === '\\\\' || e.key === '|'");
        expect(studioSrc).toContain("setDocumentPaneState(prev => prev === 'split' ? 'collapsed' : 'split')");
        expect(shortcutsSrc).toContain('⌘\\\\');
    });

    it('implements ⌘O open folder/workspace shortcut', () => {
        expect(studioSrc).toContain("keyLower === 'o'");
        expect(studioSrc).toContain('onOpenFolder');
        expect(shortcutsSrc).toContain('⌘O');
    });

    it('implements ⌘, preferences shortcut', () => {
        expect(studioSrc).toContain("e.key === ','");
        expect(studioSrc).toContain("openSettingsToTab('general')");
        expect(shortcutsSrc).toContain('⌘,');
    });

    it('implements ⌘/ keybindings cheat sheet shortcut', () => {
        expect(studioSrc).toContain("e.key === '/' || e.key === '?'");
        expect(studioSrc).toContain("openSettingsToTab('shortcuts')");
        expect(shortcutsSrc).toContain('⌘/');
    });

    it('coordinates desktop app custom events with studio state', () => {
        expect(studioSrc).toContain('scratchbox:open-preferences');
        expect(studioSrc).toContain('scratchbox:open-shortcuts');
        expect(studioSrc).toContain('scratchbox:create-file-requested');
        expect(studioSrc).toContain('scratchbox:workspace-changed');
    });
});
