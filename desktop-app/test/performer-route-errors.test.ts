/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Router } from 'express';
import { createPerformerRouter, inputErrorStatus } from '../server/routes/aiModelsRoutes';
import { InvalidInputError, MissingInputError } from '../../packages/core/src/common/errors/pipeline-errors';

function post(router: Router, url: string, body: any): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
        const req: any = { method: 'POST', url, query: {}, body, headers: {} };
        const res: any = {
            statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: any) { resolve({ status: this.statusCode, json: payload }); }
        };
        router(req, res, (err?: any) => resolve({ status: err ? 500 : 404, json: { error: err?.message || 'Not found' } }));
    });
}

describe('performer route: input errors are client errors, not 500', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-performer-route-'));
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it('maps typed input errors to 4xx and leaves the rest to 500', () => {
        expect(inputErrorStatus(new MissingInputError('t', 'x'))).toBe(400);
        expect(inputErrorStatus(new InvalidInputError('t', 'x'))).toBe(400);
        expect(inputErrorStatus(new Error('boom'))).toBeUndefined();
    });

    it('a video path that does not exist is 400 with the error code', async () => {
        const { status, json } = await post(createPerformerRouter([root]), '/run', { videoPath: path.join(root, 'missing.mp4'), outputDir: path.join(root, 'out') });
        expect(status).toBe(400);
        expect(json.success).toBe(false);
        expect(json.code).toBe('performer_input_unreadable');
    });

    it('bytes that decode to no frame are 422 (the input arrived but cannot be used)', async () => {
        const garbage = path.join(root, 'garbage.jpg');
        fs.writeFileSync(garbage, Buffer.alloc(1024));
        const { status, json } = await post(createPerformerRouter([root]), '/run', { videoPath: garbage, outputDir: path.join(root, 'out2') });
        expect(status).toBe(422);
        expect(json.code).toBe('hero_frame_extraction_failed');
    });
});
