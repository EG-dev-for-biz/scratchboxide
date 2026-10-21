import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createStandaloneServer } from '../server/app';
import { requireGoogleCredentials, withReason } from '../../packages/core/test/helpers/requirements';

// Tests 2 and 3 talk to Google: connected status needs real credentials and the stream is a billed model call.
const google = requireGoogleCredentials('live Gemini status and a streamed reply');

describe('Server Gemini Streaming Dual-Auth & Dev Origin Bypass', () => {
    let server: http.Server;
    let baseUrl: string;
    let token: string;

    beforeAll(async () => {
        const app = createStandaloneServer({ port: 0 });
        token = app.locals.launchToken;
        server = http.createServer(app);

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });

        const address = server.address() as { port: number; address: string };
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    it('1. an allowed dev Origin alone is not accepted as auth', async () => {
        const res = await fetch(`${baseUrl}/gemini/status`, {
            headers: { Origin: 'http://127.0.0.1:3030' }
        });
        expect(res.status).toBe(401);
    });

    it.skipIf(!google.ok)(withReason('2. GET /gemini/status returns connected: true with dual-auth', google), async () => {
        const res = await fetch(`${baseUrl}/gemini/status`, {
            headers: { 'X-Scratchbox-Token': token }
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.connected).toBe(true);
        expect(['service-account', 'api-key']).toContain(data.authMethod);
    });

    it.skipIf(!google.ok)(withReason('3. POST /gemini/generate-stream generates SSE stream from the dev origin with the token', google), async () => {
        const res = await fetch(`${baseUrl}/gemini/generate-stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://127.0.0.1:3030',
                'X-Scratchbox-Token': token
            },
            body: JSON.stringify({
                prompt: 'Respond with the single word: "READY"',
                temperature: 0.1
            })
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const reader = res.body?.getReader();
        expect(reader).toBeDefined();
        const decoder = new TextDecoder();
        let sseText = '';
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            sseText += decoder.decode(value, { stream: true });
        }

        expect(sseText).toContain('data:');
        expect(sseText.toLowerCase()).toContain('ready');
    }, 25000);
});
