/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat list shows each chat's real age (every chat said "now" before: `relativeTime` and `updatedAt` were the
 * literal 'Just now'), and opening a chat is not a change to it (chat-activity.ts).
 */

import { describe, expect, it } from 'vitest';
import { artifactVersionKey, chatArtifactVersionKeys, chatUpdatedAtMs, formatChatAge } from '../src/browser/generative-canvas/state/chat-activity';

const NOW = Date.UTC(2026, 10, 2, 15, 0, 0); // 2 Nov 2026, 15:00 UTC
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('a chat\'s age', () => {
    it('reads a stamped updatedAt first', () => {
        const stamped = new Date(NOW - 5 * MIN).toISOString();
        expect(chatUpdatedAtMs({ updatedAt: stamped, savedAt: NOW, messages: [{ id: `msg-user-${NOW}` }] })).toBe(NOW - 5 * MIN);
    });

    it('reads a chat saved before stamping ("Just now") from its newest message id, not from when it was last written', () => {
        // a chat the 2 Nov tour re-saved on opening: savedAt is the tour's, its last message is from 25 Oct
        const chat = {
            updatedAt: 'Just now',
            savedAt: Date.UTC(2026, 10, 2, 15, 46),
            messages: [{ id: 'msg-user-1792979496056' }, { id: 'msg-assistant-1792979594359' }, { id: 'msg-toolnode-exec-7' }]
        };
        expect(chatUpdatedAtMs(chat)).toBe(1792979594359);
        expect(chatUpdatedAtMs({ updatedAt: 'Just now', messages: [{ id: `msg-scope-${NOW - HOUR}-3` }] })).toBe(NOW - HOUR);
    });

    it('falls back to savedAt, and has no age for an untouched new chat', () => {
        expect(chatUpdatedAtMs({ updatedAt: 'Just now', savedAt: NOW - DAY, messages: [] })).toBe(NOW - DAY);
        expect(chatUpdatedAtMs({ updatedAt: 'Just now', messages: [] })).toBeUndefined();
        expect(formatChatAge(undefined, NOW)).toBe('');
    });

    it('is written short, then as a date', () => {
        expect(formatChatAge(NOW - 20_000, NOW)).toBe('now');
        expect(formatChatAge(NOW + 5_000, NOW)).toBe('now');
        expect(formatChatAge(NOW - 5 * MIN, NOW)).toBe('5m');
        expect(formatChatAge(NOW - 3 * HOUR, NOW)).toBe('3h');
        expect(formatChatAge(NOW - 2 * DAY, NOW)).toBe('2d');
        expect(formatChatAge(NOW - 15 * DAY, NOW)).toBe('2w');
        expect(formatChatAge(NOW - 40 * DAY, NOW)).toBe(new Date(NOW - 40 * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        expect(formatChatAge(Date.UTC(2025, 5, 1), NOW)).toMatch(/2025/);
    });
});

describe('what a chat holds', () => {
    it('lists every artifact version in its messages, history and stage', () => {
        const v1 = { id: 'scene', version: 1 };
        const v2 = { id: 'scene', version: 2 };
        const doc = { id: 'doc' };
        const keys = chatArtifactVersionKeys([{ artifacts: [v1] }, {}, { artifacts: [doc] }], v2, [v2, v1]);
        expect([...keys].sort()).toEqual(['doc-v1', 'scene-v1', 'scene-v2']);
        expect(artifactVersionKey(doc)).toBe('doc-v1');
    });

    it('showing a version the chat already holds adds nothing; an edit adds a new version', () => {
        const opened = chatArtifactVersionKeys([{ artifacts: [{ id: 'scene', version: 4 }] }], undefined, []);
        const shown = chatArtifactVersionKeys([{ artifacts: [{ id: 'scene', version: 4 }] }], { id: 'scene', version: 4 }, [{ id: 'scene', version: 4 }]);
        expect([...shown].every(k => opened.has(k))).toBe(true);
        const edited = chatArtifactVersionKeys([{ artifacts: [{ id: 'scene', version: 4 }] }], { id: 'scene', version: 5 }, []);
        expect([...edited].filter(k => !opened.has(k))).toEqual(['scene-v5']);
    });
});
