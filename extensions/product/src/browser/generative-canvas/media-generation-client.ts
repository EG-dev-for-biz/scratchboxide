/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Endpoint } from './endpoint';
import {
    MediaCapabilities,
    MediaGenerationJob,
    MediaGenerationRequest,
    StartMediaGenerationResponse
} from '../../common/media-generation-protocol';

export class MediaGenerationClient {
    private static instance: MediaGenerationClient;

    static getInstance(): MediaGenerationClient {
        if (!this.instance) {
            this.instance = new MediaGenerationClient();
        }
        return this.instance;
    }

    async capabilities(): Promise<MediaCapabilities> {
        return this.requestJson<MediaCapabilities>('/media/capabilities');
    }

    async start(request: MediaGenerationRequest): Promise<MediaGenerationJob> {
        const response = await this.requestJson<StartMediaGenerationResponse>('/media/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
        });
        if (!response.success || !response.job) {
            throw new Error(response.error?.message || 'Unable to start media generation');
        }
        return response.job;
    }

    async get(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob> {
        const response = await this.requestJson<StartMediaGenerationResponse>(
            `/media/jobs/${encodeURIComponent(jobId)}?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
        );
        if (!response.success || !response.job) {
            throw new Error(response.error?.message || 'Media generation job not found');
        }
        return response.job;
    }

    async cancel(jobId: string, workspaceRoot: string): Promise<MediaGenerationJob> {
        const response = await this.requestJson<StartMediaGenerationResponse>(
            `/media/jobs/${encodeURIComponent(jobId)}/cancel`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceRoot })
            }
        );
        if (!response.success || !response.job) {
            throw new Error(response.error?.message || 'Unable to cancel media generation');
        }
        return response.job;
    }

    contentUrl(jobId: string, workspaceRoot: string): string {
        return `${this.endpoint()}/media/jobs/${encodeURIComponent(jobId)}/content?workspaceRoot=${encodeURIComponent(workspaceRoot)}`;
    }

    private endpoint(): string {
        try {
            const url = new Endpoint({ path: 'gemini' }).getRestUrl().toString();
            return url.endsWith('/') ? url.slice(0, -1) : url;
        } catch {
            return '/gemini';
        }
    }

    private async requestJson<T>(suffix: string, init?: RequestInit): Promise<T> {
        const response = await fetch(`${this.endpoint()}${suffix}`, {
            headers: { Accept: 'application/json', ...(init?.headers || {}) },
            ...init
        });
        const body = await response.json();
        if (!response.ok && !body?.error) {
            throw new Error(`Media service request failed (${response.status})`);
        }
        return body as T;
    }
}
