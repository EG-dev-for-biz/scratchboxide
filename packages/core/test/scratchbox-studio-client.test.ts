/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Scratchbox Studio MCP client (studio-mcp-client.ts) against a local HTTP server that answers the way scratchbox.ai
 * does (captured 2026-10-23): Streamable HTTP `data:` events, a queued durable image job, `operation.get` until terminal,
 * the image from the storage URL. Checks the auth headers, that the Style DNA is inherited with the explicit overrides,
 * the polling, the bytes and applied presets returned, and that HTTP and tool errors throw.
 */

import * as http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callStudioTool, generateStyleDnaImage, parseMcpAnswer, studioMcpConfigFromEnv, StudioMcpError, type StudioMcpConfig } from '../src/node/scratchbox-studio/studio-mcp-client';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const OP = '129b75c8-c018-596c-89e2-ff196da639a3';

let server: http.Server;
let base = '';
const seen: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
let polls = 0;
let refuse = false;

const sse = (res: http.ServerResponse, payload: unknown) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`); };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/api/storage/serve')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(JPEG); return; }
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            seen.push({ headers: req.headers, body });
            if (req.headers['x-internal-secret'] !== 'test-secret') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Unauthorized"}'); return; }
            const { name, arguments: args } = body.params;
            if (name === 'ai.generate_images') {
                if (refuse) { sse(res, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Unknown preset lighting: moonbeam' }], isError: true } }); return; }
                sse(res, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Queued 1 durable image generation job(s)' }], structuredContent: {
                    operationId: OP, jobs: [{ index: 1, jobId: OP, cinematicPreparation: { effectivePresets: { aspectRatio: args.aspectRatio, style: 'bright editorial', filmStock: 'Portra 400', ...args.presets } } }]
                } } });
                return;
            }
            if (name === 'operation.get') {
                polls++;
                const done = polls >= 3;
                sse(res, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '' }], structuredContent: done
                    ? { operationId: OP, status: 'completed', terminal: true, result: { url: '/api/storage/serve?path=uploads%2Fworkspaces%2F217%2Fimage%2Fx.jpg' } }
                    : { operationId: OP, status: 'running', terminal: false } } });
                return;
            }
            sse(res, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `MCP error -32602: Tool ${name} not found` }], isError: true } });
        });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const config = (): StudioMcpConfig => ({ endpoint: `${base}/api/mcp/canvas`, secret: 'test-secret', userId: '1', workspaceId: '217' });

describe('Scratchbox Studio MCP client', () => {
    it('reads its connection from SCRATCHBOX_MCP_* and needs the secret, user and workspace', () => {
        expect(studioMcpConfigFromEnv({ SCRATCHBOX_MCP_SECRET: 's', SCRATCHBOX_MCP_USER_ID: '1' })).toBeUndefined();
        expect(studioMcpConfigFromEnv({ SCRATCHBOX_MCP_SECRET: 's', SCRATCHBOX_MCP_USER_ID: '1', SCRATCHBOX_MCP_WORKSPACE_ID: '217', SCRATCHBOX_MCP_CANVAS_ID: '291' }))
            .toEqual({ endpoint: 'https://scratchbox.ai/api/mcp/canvas', secret: 's', userId: '1', workspaceId: '217', canvasId: '291' });
    });

    it('parses the last data event of a Streamable HTTP answer, and a plain JSON body', () => {
        expect(parseMcpAnswer('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"a":1}}}\n\n').result?.structuredContent).toEqual({ a: 1 });
        expect(parseMcpAnswer('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}').result?.content).toEqual([]);
    });

    it('draws one image in the workspace Style DNA with the overrides, polls the job, and returns the image bytes', async () => {
        seen.length = 0; polls = 0; refuse = false;
        const image = await generateStyleDnaImage(config(), {
            prompt: 'a cast-iron fire hydrant', idempotencyKey: 'k-1', presets: { lighting: 'overcast soft', depthOfField: 'deep focus' }, maxEstimatedCost: 50
        }, { sleep: async () => undefined });
        expect(image.data.equals(JPEG)).toBe(true);
        expect(image.mimeType).toBe('image/jpeg');
        expect(image.operationId).toBe(OP);
        expect(image.url).toBe(`${base}/api/storage/serve?path=uploads%2Fworkspaces%2F217%2Fimage%2Fx.jpg`);
        expect(image.effectivePresets).toMatchObject({ style: 'bright editorial', lighting: 'overcast soft', depthOfField: 'deep focus' });
        // auth headers on every call; the Style DNA inherited, the overrides passed, one image, no server-side wait
        expect(seen.every(s => s.headers['x-internal-user-id'] === '1' && s.headers['x-scratchbox-workspace-id'] === '217')).toBe(true);
        const gen = seen[0].body.params;
        expect(gen.name).toBe('ai.generate_images');
        expect(gen.arguments).toMatchObject({ prompt: 'a cast-iron fire hydrant', count: 1, aspectRatio: '1:1', inheritCanvasStyle: true, idempotencyKey: 'k-1', waitForCompletion: false, maxEstimatedCost: 50, presets: { lighting: 'overcast soft', depthOfField: 'deep focus' } });
        expect(seen.filter(s => s.body.params.name === 'operation.get')).toHaveLength(3);
    });

    it('throws on a tool error, an unknown tool and a rejected secret', async () => {
        refuse = true;
        await expect(generateStyleDnaImage(config(), { prompt: 'x', idempotencyKey: 'k-2' })).rejects.toThrow(/Unknown preset lighting/);
        await expect(callStudioTool(config(), 'auth_whoami', {})).rejects.toBeInstanceOf(StudioMcpError);
        await expect(callStudioTool({ ...config(), secret: 'wrong' }, 'auth.whoami', {})).rejects.toThrow(/HTTP 401/);
        refuse = false;
    });
});
