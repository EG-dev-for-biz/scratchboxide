/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    MediaGenerationJob,
    MediaGenerationRequest,
    PersistedMediaGenerationRequest,
    classifyMediaGenerationError,
    validateMediaGenerationRequest
} from '../common/media-generation-protocol';
import { GoogleMediaGenerationService, MediaGenerationStage } from './google-media-generation-service';

interface MediaJobStoreFile {
    version: 1;
    jobs: MediaGenerationJob[];
}

type MediaJobListener = (job: MediaGenerationJob) => void;
export class MediaGenerationJobService {
    private readonly listeners: MediaJobListener[] = [];
    private readonly stores = new Map<string, MediaJobStoreFile>();

    constructor(
        private readonly generator: GoogleMediaGenerationService
    ) {}

    onDidChange(listener: MediaJobListener): () => void {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) {
                this.listeners.splice(index, 1);
            }
        };
    }

    async create(request: MediaGenerationRequest): Promise<MediaGenerationJob> {
        validateMediaGenerationRequest(request);
        const store = await this.load(request.workspaceRoot);
        const duplicate = store.jobs.find(job => job.request.idempotencyKey === request.idempotencyKey);
        if (duplicate) {
            return duplicate;
        }

        const timestamp = new Date().toISOString();
        const job: MediaGenerationJob = {
            id: `media-job-${createHash('sha256')
                .update(`${request.kind}:${request.idempotencyKey}`)
                .digest('hex')
                .slice(0, 24)}`,
            status: 'queued',
            request: this.sanitizeRequest(request),
            createdAt: timestamp,
            updatedAt: timestamp
        };
        store.jobs.push(job);
        await this.persist(request.workspaceRoot, store);
        this.emit(job);
        return job;
    }

    async get(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob | undefined> {
        return (await this.load(workspaceRoot)).jobs.find(job => job.id === jobId);
    }

    async list(workspaceRoot: string): Promise<MediaGenerationJob[]> {
        return [...(await this.load(workspaceRoot)).jobs];
    }

    async process(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob> {
        const job = await this.requireJob(jobId, workspaceRoot);
        if (job.status === 'completed' || job.status === 'cancelled') {
            return job;
        }

        try {
            await this.transition(job, workspaceRoot, 'submitting');
            await this.transition(job, workspaceRoot, 'running');
            const request = { ...job.request, workspaceRoot } as MediaGenerationRequest;
            let result;
            if (request.kind === 'image') {
                result = await this.generator.generateImage(request);
            } else if (request.kind === 'video') {
                result = await this.generator.generateVideo(request, async (
                    stage: MediaGenerationStage,
                    operationName?: string,
                    model?: string
                ) => {
                    job.operationName = operationName || job.operationName;
                    job.modelUsed = model || job.modelUsed;
                    await this.transition(job, workspaceRoot, stage);
                });
            } else {
                // No generator backs this media kind yet: fail the job explicitly instead of fabricating an asset.
                const message = `Media generation for kind '${(request as MediaGenerationRequest).kind}' is not supported by the job service ` +
                    `(supported kinds: image, video)`;
                throw Object.assign(new Error(message), {
                    mediaError: { code: 'unsupported', message, retryable: false, model: job.modelUsed }
                });
            }

            if (this.isCancelled(job)) {
                return job;
            }
            job.result = result;
            job.operationName = result.operationName || job.operationName;
            job.modelUsed = result.modelUsed;
            job.error = undefined;
            await this.transition(job, workspaceRoot, 'completed');
        } catch (error) {
            if (!this.isCancelled(job)) {
                job.error = (error as any)?.mediaError || classifyMediaGenerationError(error, job.modelUsed);
                await this.transition(job, workspaceRoot, 'failed');
            }
        }
        return job;
    }

    async cancel(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob> {
        const job = await this.requireJob(jobId, workspaceRoot);
        if (job.status !== 'completed' && job.status !== 'failed') {
            job.error = {
                code: 'cancelled',
                message: 'Media generation was cancelled locally',
                retryable: false,
                model: job.modelUsed
            };
            await this.transition(job, workspaceRoot, 'cancelled');
        }
        return job;
    }

    async recover(workspaceRoot: string): Promise<MediaGenerationJob[]> {
        const store = await this.load(workspaceRoot);
        const recoverable = store.jobs.filter(job =>
            job.status === 'submitting' ||
            job.status === 'running' ||
            job.status === 'downloading'
        );
        for (const job of recoverable) {
            job.status = 'queued';
            job.updatedAt = new Date().toISOString();
        }
        if (recoverable.length) {
            await this.persist(workspaceRoot, store);
            recoverable.forEach(job => this.emit(job));
        }
        return recoverable;
    }

    private async transition(
        job: MediaGenerationJob,
        workspaceRoot: string,
        status: MediaGenerationJob['status']
    ): Promise<void> {
        job.status = status;
        job.updatedAt = new Date().toISOString();
        await this.persist(workspaceRoot, await this.load(workspaceRoot));
        this.emit(job);
    }

    private sanitizeRequest(request: MediaGenerationRequest): PersistedMediaGenerationRequest {
        const {
            workspaceRoot: _workspaceRoot,
            ...persisted
        } = request;
        return persisted;
    }

    private async requireJob(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob> {
        const job = await this.get(jobId, workspaceRoot);
        if (!job) {
            throw new Error(`Unknown media generation job ${jobId}`);
        }
        return job;
    }

    private async load(workspaceRoot: string): Promise<MediaJobStoreFile> {
        const root = path.resolve(workspaceRoot);
        const cached = this.stores.get(root);
        if (cached) {
            return cached;
        }
        const filePath = this.storePath(root);
        const loaded: MediaJobStoreFile = await fs.pathExists(filePath)
            ? await fs.readJSON(filePath)
            : { version: 1, jobs: [] };
        if (loaded.version !== 1 || !Array.isArray(loaded.jobs)) {
            throw new Error('Unsupported or invalid media job store');
        }
        this.stores.set(root, loaded);
        return loaded;
    }

    private async persist(workspaceRoot: string, store: MediaJobStoreFile): Promise<void> {
        const filePath = this.storePath(workspaceRoot);
        await fs.ensureDir(path.dirname(filePath));
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        await fs.writeJSON(temporaryPath, store, { spaces: 2, mode: 0o600 });
        await fs.rename(temporaryPath, filePath);
    }

    private storePath(workspaceRoot: string): string {
        return path.join(path.resolve(workspaceRoot), '.scratchbox', 'media-jobs.json');
    }

    private emit(job: MediaGenerationJob): void {
        this.listeners.slice().forEach(listener => listener(job));
    }

    private isCancelled(job: MediaGenerationJob): boolean {
        return job.status === 'cancelled';
    }
}
