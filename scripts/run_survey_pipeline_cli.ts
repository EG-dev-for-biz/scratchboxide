#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { resolveSurveyPreset } from '../packages/core/src/node/spatial/survey-router';
import { SurveySplatPipelineService } from '../packages/core/src/node/spatial/SurveySplatPipelineService';
import { createDefaultStationImageGenerator } from '../packages/core/src/node/spatial/BeautifyStationService';

async function main() {
    const args = process.argv.slice(2);
    const getArg = (flag: string) => {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
    };
    const hasFlag = (flag: string) => args.includes(flag);

    let jobFile = getArg('--job-file');
    let requestPayload: any = {};

    if (jobFile && fs.existsSync(jobFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
            requestPayload = raw.request || raw;
        } catch (e: any) {
            console.error('Failed to parse job file:', e.message);
        }
    }

    // No default place: without a location (or anchor in the job) resolveSurveyPreset fails and the job says why.
    const location = getArg('--location') || requestPayload.location || requestPayload.activeModel;
    const sigmaScale = parseFloat(getArg('--sigma-scale') || requestPayload.sigmaScale || '0.5');
    const voxelSizeMeters = parseFloat(getArg('--voxel-size') || requestPayload.voxelSizeMeters || '0.05');
    const forceRebake = hasFlag('--force-rebake') || requestPayload.forceRebake !== false;
    const clean = hasFlag('--clean') || requestPayload.clean === true;
    const cropRadius = getArg('--crop-radius') ? parseFloat(getArg('--crop-radius')!) : requestPayload.cropRadius;
    const regenerateImages = hasFlag('--regenerate-images') || requestPayload.regenerateImages === true;

    const surveyPreset = getArg('--preset') || requestPayload.surveyPreset;
    const cameraCount = getArg('--camera-count') ? parseInt(getArg('--camera-count')!, 10) : requestPayload.cameraCount;

    const workspaceRoot = process.cwd();

    const updateJob = (status: 'running' | 'done' | 'error', progress: number, message?: string, result?: any, error?: string) => {
        if (!jobFile) return;
        try {
            const current = fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, 'utf8')) : {};
            const updated = {
                ...current,
                status,
                progress: Math.max(0, Math.min(1, progress)),
                message: message || current.message,
                updatedAt: Date.now(),
                result: result !== undefined ? result : current.result,
                error: error !== undefined ? error : current.error
            };
            fs.writeFileSync(jobFile, JSON.stringify(updated, null, 2), 'utf8');
        } catch {}
    };

    let preset: Awaited<ReturnType<typeof resolveSurveyPreset>>;
    try {
        preset = await resolveSurveyPreset({
            location,
            sigmaScale,
            voxelSizeMeters,
            cropRadius,
            surveyPreset,
            cameraCount,
            ...requestPayload
        }, workspaceRoot);
    } catch (err: any) {
        const message = err?.message || String(err);
        console.error('[SurveyPipeline] Could not resolve the survey location:', message);
        updateJob('error', 1.0, message, null, message);
        process.exit(1);
    }

    updateJob('running', 0.05, `Initializing survey pipeline for ${preset.beautify.locationName}...`);

    const svc = new SurveySplatPipelineService({ generator: createDefaultStationImageGenerator({ workspaceRoot }) });
    const outDir = path.resolve(workspaceRoot, preset.outDir);

    console.log(`[SurveyPipeline] Running 3DGS pipeline for ${preset.beautify.locationName}`);
    console.log(`[SurveyPipeline] OutDir: ${outDir}, Stations: ${preset.stations.length}, Sigma: ${preset.sigmaScale}, Voxel: ${preset.voxelSizeMeters}m`);

    const res = await svc.run({
        glbPath: path.resolve(workspaceRoot, preset.glbPath),
        anchor: preset.anchor,
        stations: preset.stations,
        outDir,
        beautify: preset.beautify,
        mode: 'chained',
        sigmaScale: preset.sigmaScale,
        voxelSizeMeters: preset.voxelSizeMeters,
        forceRebake,
        clean: clean && !requestPayload.reusePlates,
        cropRadius: preset.cropRadius,
        cropBox: preset.cropBox,
        erodeSilhouettePx: preset.erodeSilhouettePx,
        dropInconsistent: preset.dropInconsistent,
        colorConsistencyThresh: preset.colorConsistencyThresh,
        use2dgs: requestPayload.use2dgs === true || hasFlag('--2dgs') || requestPayload.surfaceModel === 'planar',
        surfaceModel: requestPayload.surfaceModel || (requestPayload.use2dgs || hasFlag('--2dgs') ? 'planar' : undefined),
        shDegree: requestPayload.shDegree !== undefined ? parseInt(requestPayload.shDegree, 10) : (getArg('--sh-degree') ? parseInt(getArg('--sh-degree')!, 10) : undefined),
        exposureScale: requestPayload.exposureScale !== undefined ? parseFloat(requestPayload.exposureScale) : (getArg('--exposure-scale') ? parseFloat(getArg('--exposure-scale')!) : undefined)
    }, (prog: number, msg?: string) => {
        console.log(`[SurveyPipeline] ${(prog * 100).toFixed(0)}% - ${msg || ''}`);
        updateJob('running', prog, msg);
    });

    if (!res.success) {
        console.error('[SurveyPipeline] Pipeline failed:', res.error);
        updateJob('error', 1.0, res.error, null, res.error);
        process.exit(1);
    }

    const publicRoot = path.resolve(workspaceRoot, 'public');
    const rel = path.relative(publicRoot, res.tilesetPath);
    const tilesetUrl = rel && !rel.startsWith('..') ? '/' + rel.split(path.sep).join('/') : undefined;

    const finalResult = {
        ...res,
        tilesetUrl,
        locationName: preset.beautify.locationName
    };

    console.log(`[SurveyPipeline] Done! Tileset: ${tilesetUrl}, Fused splats: ${res.fusedSplatCount}`);
    updateJob('done', 1.0, `Complete! Fused ${res.fusedSplatCount.toLocaleString()} splats.`, finalResult);
}

main().catch((err) => {
    console.error('[SurveyPipeline] Fatal error:', err);
    process.exit(1);
});
