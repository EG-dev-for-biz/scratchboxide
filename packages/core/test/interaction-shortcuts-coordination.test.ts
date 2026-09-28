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

describe('Interaction Shortcuts & Keyboard Coordination Suite', () => {
    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const shortcutsTabPath = path.resolve(__dirname, '../src/browser/generative-canvas/settings/tabs/ShortcutsTab.tsx');
    const composerInputPath = path.resolve(__dirname, '../src/browser/generative-canvas/hooks/useComposerInput.ts');

    it('GenerativeCanvasStudio coordinates standard IDE keyboard shortcuts', () => {
        const studioSrc = fs.readFileSync(studioTsxPath, 'utf8');

        // 1. Command palette / spotlight quick-open
        expect(studioSrc).toContain("keyLower === 'k' || keyLower === 'p'");

        // 2. Toggle sidebar
        expect(studioSrc).toContain("keyLower === 'b'");

        // 3. Focus composer
        expect(studioSrc).toContain("keyLower === 'l' || keyLower === 'j'");

        // 4. New chat session
        expect(studioSrc).toContain("keyLower === 'n'");

        // 5. Save & commit canvas artifact
        expect(studioSrc).toContain("keyLower === 's'");
        expect(studioSrc).toContain('/workspace/sync-artifact');

        // 6. New sandbox tab
        expect(studioSrc).toContain("keyLower === 't'");
        expect(studioSrc).toContain('handleCreateNewSandboxTab()');

        // 7. Close tab
        expect(studioSrc).toContain("keyLower === 'w'");
        expect(studioSrc).toContain('handleCloseArtifactTab');

        // 8. Numbered tab navigation (⌘1 – ⌘9)
        expect(studioSrc).toContain('/^[1-9]$/.test(e.key)');
        expect(studioSrc).toContain('handleSelectArtifactTab(canvasArtifactTabs[targetIdx])');

        // 9. Tab cycling (⌥⌘← / ⌥⌘→)
        expect(studioSrc).toContain("e.key === 'ArrowLeft' || e.key === 'ArrowRight'");

        // 10. Split view toggle (⌘\)
        expect(studioSrc).toContain("e.key === '\\\\'");

        // 11. Settings & Keybindings shortcuts (⌘, and ⌘/)
        expect(studioSrc).toContain("e.key === ','");
        expect(studioSrc).toContain("e.key === '/'");
    });

    it('ShortcutsTab documents all coordinated keystrokes accurately', () => {
        const shortcutsSrc = fs.readFileSync(shortcutsTabPath, 'utf8');

        expect(shortcutsSrc).toContain('⌘P / ⌘K');
        expect(shortcutsSrc).toContain('⌘B');
        expect(shortcutsSrc).toContain('⌘L / ⌘J');
        expect(shortcutsSrc).toContain('⌘S');
        expect(shortcutsSrc).toContain('⌘T');
        expect(shortcutsSrc).toContain('⌘W');
        expect(shortcutsSrc).toContain('⌘1 – ⌘9');
        expect(shortcutsSrc).toContain('⌥⌘← / ⌥⌘→');
        expect(shortcutsSrc).toContain('⌘\\');
        expect(shortcutsSrc).toContain('⌘N');
        expect(shortcutsSrc).toContain('⌘,');
    });

    it('useComposerInput supports submitting with Enter and Cmd+Enter, while preserving Shift+Enter for newlines', () => {
        const composerSrc = fs.readFileSync(composerInputPath, 'utf8');

        expect(composerSrc).toContain("e.key === 'Enter'");
        expect(composerSrc).toContain('!e.shiftKey || e.metaKey || e.ctrlKey');
        expect(composerSrc).toContain('handleSendMessage()');
    });
});
