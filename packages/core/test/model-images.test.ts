/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Images a tool shows the model (streaming.ts modelImageParts, workspace_view_image): a tool result's modelImages become
 * a label and an inline image after the turn's tool responses, the JSON keeps only their labels; the turn's allowance and
 * the size cap are kept and say why an image was not shown; workspace_view_image shows a workspace image and refuses a
 * file that is not one, or a path outside the workspace.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MAX_MODEL_IMAGES_PER_TURN, modelImageParts } from '../src/node/gemini/streaming';
import { workspaceHandlers } from '../src/node/gemini/tools/workspace-tools';
import { READ_ONLY_TOOLS } from '../src/node/gemini/tool-permissions';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a10000000049454e44ae426082', 'hex');

describe('images shown to the model', () => {
    it('turns modelImages into a label and an inline image, and lists them by label in the JSON', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-images-'));
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, PNG);
        const budget = { left: MAX_MODEL_IMAGES_PER_TURN };
        const r = modelImageParts('survey_tool', { status: 'success', modelImages: [{ path: file, mimeType: 'image/png', label: 'station 3' }, { path: path.join(dir, 'missing.png'), label: 'gone' }] }, budget);
        expect(r.parts).toHaveLength(2);
        expect((r.parts[0] as { text: string }).text).toMatch(/^Image from survey_tool: station 3 \(\d+ x \d+ px\)$/);
        const inline = r.parts[1] as { inlineData: { data: string; mimeType: string } };
        expect(inline.inlineData.mimeType).toBe('image/jpeg');
        expect(inline.inlineData.data.length).toBeGreaterThan(0);
        expect(r.payload.modelImages).toBeUndefined();
        expect(r.payload.images[0]).toEqual({ label: 'station 3', shown: true });
        expect(r.payload.images[1].shown).toBe(false);
        expect(r.payload.images[1].why).toMatch(/could not be read/);
        expect(budget.left).toBe(MAX_MODEL_IMAGES_PER_TURN - 1);
    });

    it('keeps the turn allowance and leaves a result without images alone', () => {
        const budget = { left: 1 };
        const r = modelImageParts('t', { modelImages: [{ data: 'AAAA', label: 'one' }, { data: 'BBBB', label: 'two' }] }, budget);
        expect(r.parts).toHaveLength(2);
        expect(r.payload.images[1]).toMatchObject({ label: 'two', shown: false });
        expect(r.payload.images[1].why).toMatch(/over 8 images this turn/);
        const plain = { status: 'success', x: 1 };
        expect(modelImageParts('t', plain, { left: 8 })).toEqual({ payload: plain, parts: [] });
    });

    it('workspace_view_image shows a workspace image, refuses other files and paths outside the workspace; it is read-only', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
        fs.mkdirSync(path.join(root, 'plates'));
        fs.writeFileSync(path.join(root, 'plates', 'wall.png'), PNG);
        fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
        const ctx = { workspaceRoot: root } as never;
        const ok = await workspaceHandlers.workspace_view_image({ filePath: 'plates/wall.png', label: 'north wall' }, ctx);
        const shown = ok.resultPayload.modelImages as Array<{ path: string; mimeType: string; label: string }>;
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatchObject({ mimeType: 'image/png', label: 'north wall' });
        expect(fs.realpathSync(shown[0].path)).toBe(fs.realpathSync(path.join(root, 'plates', 'wall.png')));
        await expect(Promise.resolve(workspaceHandlers.workspace_view_image({ filePath: 'notes.txt' }, ctx))).rejects.toThrow(/Not an image/);
        await expect(Promise.resolve(workspaceHandlers.workspace_view_image({ filePath: '../../etc/x.png' }, ctx))).rejects.toThrow();
        expect(READ_ONLY_TOOLS.has('workspace_view_image')).toBe(true);
    });
});
