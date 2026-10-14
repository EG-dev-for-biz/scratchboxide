/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GeoCameraMatchmovePipelineService } from '../src/node/spatial/GeoCameraMatchmovePipelineService';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const FFPROBE = '/opt/homebrew/bin/ffprobe';
const hasFfmpeg = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);

describe.skipIf(!hasFfmpeg)('GeoCameraMatchmovePipelineService argv safety', () => {
    it('probes videos whose paths contain shell metacharacters without executing them', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-argv-'));
        try {
            // A shell would run these relative to the process cwd; file names cannot contain '/'.
            const markerName = `sbx_argv_injected_${process.pid}_${Date.now()}`;
            const marker = path.join(process.cwd(), markerName);
            // Quotes, command substitution and separators would all break out of the old
            // execSync/exec string interpolation.
            const hostileName = `clip"; touch ${markerName}; echo "$(touch ${markerName}2).mp4`;
            const videoPath = path.join(dir, hostileName);
            execFileSync(FFMPEG, [
                '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=24', '-t', '0.5',
                '-pix_fmt', 'yuv420p', videoPath
            ]);
            expect(fs.existsSync(videoPath)).toBe(true);

            const service = new GeoCameraMatchmovePipelineService(undefined, FFMPEG, FFPROBE);
            const metadata = await service.analyzeVideo(videoPath);

            expect(metadata.width).toBe(64);
            expect(metadata.height).toBe(48);
            expect(metadata.fps).toBeCloseTo(24, 3);
            expect(fs.existsSync(marker)).toBe(false);
            expect(fs.existsSync(`${marker}2`)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
            for (const leftover of fs.readdirSync(process.cwd()).filter(f => f.startsWith('sbx_argv_injected_'))) {
                fs.rmSync(path.join(process.cwd(), leftover), { force: true });
            }
        }
    });
});
