/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chat opened to look at it starts nothing paid (user decision, 2026-11-02): its scene's lost files are restored
 * from the asset store only, never in the same job as files that may be rebuilt, and the viewport offers "Rebuild this
 * location" in place of rebuilding on its own (asset-recovery-client.ts, chat-activity.ts, Scene3DPrimitive).
 */

import { describe, expect, it } from 'vitest';
import { AssetRecoveryClient } from '../src/browser/generative-canvas/services/asset-recovery-client';
import { chatArtifactVersionKeys, isFromOpenedChat, noteOpenedChatArtifacts } from '../src/browser/generative-canvas/state/chat-activity';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function recordingFetch() {
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method !== 'POST' || !url.endsWith('/api/assets/recover')) throw new Error(`unexpected request ${url}`);
        const body = JSON.parse(init.body || '{}');
        posts.push(body);
        const items = (body.paths as string[]).map(path => ({ path, outcome: 'unrecoverable' }));
        return new Response(JSON.stringify({ job: { id: `job-${posts.length}`, status: 'done', items, message: 'done', startedAtMs: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { posts, fetchImpl };
}

describe('asset recovery for a chat opened to look at it', () => {
    it('sends restore-only paths as their own restore-only job, after paths that may be rebuilt', async () => {
        const { posts, fetchImpl } = recordingFetch();
        const client = new AssetRecoveryClient(fetchImpl);
        client.request(['/models/opened_iso_tiles_52c85820.glb'], { restoreOnly: true });
        client.request(['/models/fresh_l2_deadbeef.glb']);
        await wait(900);
        expect(posts).toEqual([
            { paths: ['/models/fresh_l2_deadbeef.glb'] },
            { paths: ['/models/opened_iso_tiles_52c85820.glb'], restoreOnly: true }
        ]);
    });

    it('lets a path asked for both ways be rebuilt, and an explicit rebuild is never restore-only', async () => {
        const { posts, fetchImpl } = recordingFetch();
        const client = new AssetRecoveryClient(fetchImpl);
        client.request(['/models/shared_l2_deadbeef.glb'], { restoreOnly: true });
        client.request(['/models/shared_l2_deadbeef.glb']);
        await wait(500);
        expect(posts).toEqual([{ paths: ['/models/shared_l2_deadbeef.glb'] }]);

        client.rebuild(['/models/opened_iso_tiles_52c85820.glb'], { query: 'Jefferson Market Library', isolate: true });
        await wait(50);
        expect(posts[1]).toEqual({ paths: ['/models/opened_iso_tiles_52c85820.glb'], fallbackStagedRequest: { query: 'Jefferson Market Library', isolate: true } });
    });

    it('knows a scene version that came from an opened chat from one made or edited here', () => {
        const opened = { id: 'art-stmarks', version: 4 };
        noteOpenedChatArtifacts(chatArtifactVersionKeys([{ artifacts: [opened] }], undefined, []));
        expect(isFromOpenedChat(opened)).toBe(true);
        expect(isFromOpenedChat({ id: 'art-stmarks', version: 5 })).toBe(false);
        expect(isFromOpenedChat({ id: 'art-new-build' })).toBe(false);
        expect(isFromOpenedChat(undefined)).toBe(false);
    });
});
