/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Request, Response, Router } from 'express';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ObjectSegmenterService } from '../../../packages/core/src/node/video/ObjectSegmenterService';
import { PipelineError } from '../../../packages/core/src/common/errors/pipeline-errors';

/** Largest reference photo accepted, in bytes once decoded. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * The viewport's look match (Colour harmony panel): the part of a reference photo a description picks out, as a mask, so
 * the photo's look is measured on that part only (open-vocabulary segmentation, ObjectSegmenterService).
 */
export function createColorMatchRouter(): Router {
    const router = Router();
    const segmenter = new ObjectSegmenterService();

    router.post('/segment', async (req: Request, res: Response) => {
        const { imageBase64, mimeType, target } = req.body || {};
        if (typeof imageBase64 !== 'string' || !imageBase64) return res.status(400).json({ success: false, error: 'imageBase64 (the reference photo) is required' });
        if (typeof target !== 'string' || !target.trim()) return res.status(400).json({ success: false, error: 'target (what to cut out of the photo) is required' });
        const bytes = Buffer.from(imageBase64, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return res.status(400).json({ success: false, error: `the photo must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
        const ext = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-look-match-'));
        try {
            const imagePath = path.join(dir, `reference${ext}`);
            await fs.writeFile(imagePath, bytes);
            const result = await segmenter.segment({ imagePath, outputDir: path.join(dir, 'out'), target: target.trim() });
            const mask = await fs.readFile(result.maskPaths[0]);
            res.json({
                success: true,
                width: result.width,
                height: result.height,
                maskBase64: mask.toString('base64'),
                areaFraction: result.frames[0]?.areaFraction,
                found: result.prompts.visionModel?.label ?? result.prompts.target,
                model: result.prompts.visionModel?.model
            });
        } catch (err: any) {
            const status = err instanceof PipelineError ? 422 : 500;
            res.status(status).json({ success: false, error: err?.message || String(err), code: err?.name });
        } finally {
            await fs.remove(dir).catch(() => undefined);
        }
    });

    return router;
}
