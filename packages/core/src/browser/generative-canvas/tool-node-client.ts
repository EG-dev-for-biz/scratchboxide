/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Endpoint } from './endpoint';
import type { ToolNodeCatalogEntry, ToolNodeCatalogResponse, ToolNodeRunEvent, ToolNodeRunRequest, ToolNodeRunResponse } from '../../common/tool-node-protocol';

/** The canvas side of tool nodes: the tool catalog (fetched once) and single tool runs. */
export class ToolNodeClient {
    private static instance: ToolNodeClient | undefined;
    private catalog: Promise<ToolNodeCatalogEntry[]> | undefined;

    static getInstance(): ToolNodeClient {
        if (!ToolNodeClient.instance) ToolNodeClient.instance = new ToolNodeClient();
        return ToolNodeClient.instance;
    }

    listTools(): Promise<ToolNodeCatalogEntry[]> {
        if (!this.catalog) {
            this.catalog = fetch(`${this.endpoint()}/tools/catalog`, { headers: { Accept: 'application/json' } })
                .then(r => r.json() as Promise<ToolNodeCatalogResponse>)
                .then(body => {
                    if (!body.success) throw new Error(body.error?.message || 'Unable to list tools');
                    return body.tools;
                });
            // a failed load is retried on the next call instead of being cached
            this.catalog.catch(() => { this.catalog = undefined; });
        }
        return this.catalog;
    }

    async run(request: ToolNodeRunRequest, signal?: AbortSignal): Promise<ToolNodeRunResponse> {
        const response = await fetch(`${this.endpoint()}/tools/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(request),
            signal
        });
        const body = await response.json() as ToolNodeRunResponse;
        if (!response.ok && !body?.error) throw new Error(`Tool request failed (${response.status})`);
        return body;
    }

    /** A run streamed line by line: `onEvent` sees progress and staged commits as they happen; resolves with the result. */
    async runStream(request: ToolNodeRunRequest, onEvent: (event: Exclude<ToolNodeRunEvent, { type: 'done' }>) => void, signal?: AbortSignal): Promise<ToolNodeRunResponse> {
        const response = await fetch(`${this.endpoint()}/tools/run-stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
            body: JSON.stringify(request),
            signal
        });
        if (!response.ok || !response.body) throw new Error(`Tool request failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        let result: ToolNodeRunResponse | undefined;
        const handle = (line: string) => {
            if (!line.trim()) return;
            const event = JSON.parse(line) as ToolNodeRunEvent;
            if (event.type === 'done') result = event.result;
            else onEvent(event);
        };
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffered.indexOf('\n')) >= 0) {
                handle(buffered.slice(0, nl));
                buffered = buffered.slice(nl + 1);
            }
        }
        handle(buffered);
        if (!result) throw new Error('The tool run ended without a result (the server may have restarted)');
        return result;
    }

    private endpoint(): string {
        try {
            const url = new Endpoint({ path: 'gemini' }).getRestUrl().toString();
            return url.endsWith('/') ? url.slice(0, -1) : url;
        } catch {
            return '/gemini';
        }
    }
}
