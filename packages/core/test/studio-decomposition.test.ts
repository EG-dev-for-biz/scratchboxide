/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Guards for the Studio / Settings decomposition.
 *
 * `GenerativeCanvasStudio.tsx` (8.9k lines, 80 useState) and `SettingsModal.tsx` (4k lines,
 * 137 useState) were split into `studio/`, `chat/`, `state/`, `hooks/` and `settings/`.
 * These assertions keep them from growing back into monoliths.
 */
import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GENERATIVE_CANVAS_DIR, SETTINGS_ENTRY, STUDIO_ENTRY, listSettingsSourceFiles, listStudioSourceFiles } from './source-helpers';

const OWNED_FILES = [
    STUDIO_ENTRY,
    SETTINGS_ENTRY,
    path.join(GENERATIVE_CANVAS_DIR, 'ChatMarkdownRenderer.tsx'),
    path.join(GENERATIVE_CANVAS_DIR, 'ProjectsModal.tsx'),
    path.join(GENERATIVE_CANVAS_DIR, 'GoogleDriveConnectModal.tsx'),
    path.join(GENERATIVE_CANVAS_DIR, 'google-drive-service.ts'),
    ...listStudioSourceFiles(),
    ...listSettingsSourceFiles()
];

function lineCount(file: string): number {
    return fs.readFileSync(file, 'utf-8').split('\n').length;
}

test('GenerativeCanvasStudio.tsx stays a thin composition root (< 2500 lines)', () => {
    const lines = lineCount(STUDIO_ENTRY);
    assert.ok(lines < 2500, `GenerativeCanvasStudio.tsx has ${lines} lines; expected < 2500`);
});

test('SettingsModal.tsx stays a thin shell (< 400 lines)', () => {
    const lines = lineCount(SETTINGS_ENTRY);
    assert.ok(lines < 400, `SettingsModal.tsx has ${lines} lines; expected < 400`);
});

function countUseState(source: string): number {
    const qualified = (source.match(/\bReact\.useState\s*[<(]/g) || []).length;
    // Bare `useState(` only counts when the file itself imports it (not sample code inside strings).
    const importsBare = /^import\s[^;]*\buseState\b[^;]*from\s+['"]react['"]/m.test(source);
    const bare = importsBare ? (source.match(/(?<![.\w])useState\s*[<(]/g) || []).length : 0;
    return qualified + bare;
}

test('no decomposed Studio/Settings file declares more than 25 useState hooks', () => {
    // Scoped to the files owned by the decomposition (primitives/ etc. are tracked separately).
    const offenders: string[] = [];
    for (const file of OWNED_FILES) {
        if (!fs.existsSync(file)) {
            continue;
        }
        const count = countUseState(fs.readFileSync(file, 'utf-8'));
        if (count > 25) {
            offenders.push(`${path.relative(GENERATIVE_CANVAS_DIR, file)} (${count})`);
        }
    }
    assert.deepStrictEqual(offenders, [], `Files with > 25 useState: ${offenders.join(', ')}`);
});

test('chat/MessageItem.tsx is memoized with React.memo', () => {
    const file = path.join(GENERATIVE_CANVAS_DIR, 'chat', 'MessageItem.tsx');
    assert.ok(fs.existsSync(file), 'chat/MessageItem.tsx must exist');
    const source = fs.readFileSync(file, 'utf-8');
    assert.ok(/React\.memo\(/.test(source), 'MessageItem must be wrapped in React.memo');
});

test('hooks/useSendMessage.ts exists and cancels in-flight streams with AbortController', () => {
    const file = path.join(GENERATIVE_CANVAS_DIR, 'hooks', 'useSendMessage.ts');
    assert.ok(fs.existsSync(file), 'hooks/useSendMessage.ts must exist');
    const source = fs.readFileSync(file, 'utf-8');
    assert.ok(source.includes('AbortController'), 'useSendMessage must use AbortController');
});

test('decomposed files do not use bare array indices as React keys', () => {
    const offenders: string[] = [];
    for (const file of OWNED_FILES) {
        if (!fs.existsSync(file)) {
            continue;
        }
        const source = fs.readFileSync(file, 'utf-8');
        if (/key=\{(idx|i|index)\}/.test(source)) {
            offenders.push(path.relative(GENERATIVE_CANVAS_DIR, file));
        }
    }
    assert.deepStrictEqual(offenders, [], `Index keys found in: ${offenders.join(', ')}`);
});

test('GenerativeCanvasStudio.tsx contains no hard-coded /Users/ paths', () => {
    const source = fs.readFileSync(STUDIO_ENTRY, 'utf-8');
    assert.ok(!source.includes('/Users/'), 'Studio must not embed personal filesystem paths');
});

test('settings tabs each live in their own file under settings/tabs', () => {
    const tabsDir = path.join(GENERATIVE_CANVAS_DIR, 'settings', 'tabs');
    const expected = [
        'GeneralTab', 'ProfileTab', 'AppearanceTab', 'PlanTab', 'AgentsTab', 'CloudAgentsTab', 'ModelsTab',
        'GitPrsTab', 'WorktreesTab', 'BrowserNetworkTab', 'TabTab', 'CodeIntelligenceTab', 'BetaTab',
        'WorkspaceTab', 'SkillsTab', 'McpTab', 'ShortcutsTab', 'AboutTab', 'MemoriesTab', 'DocsTab'
    ];
    for (const name of expected) {
        assert.ok(fs.existsSync(path.join(tabsDir, `${name}.tsx`)), `settings/tabs/${name}.tsx must exist`);
    }
    const reducer = fs.readFileSync(path.join(GENERATIVE_CANVAS_DIR, 'settings', 'settingsReducer.ts'), 'utf-8');
    assert.ok(reducer.includes('useReducer'), 'settingsReducer.ts must back the settings store with useReducer');
});
