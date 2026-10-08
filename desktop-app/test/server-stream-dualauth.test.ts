import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createStandaloneServer } from '../server/app';

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

    it('1. GET /api/auth/token returns the launch token for allowed dev origins', async () => {
        const res = await fetch(`${baseUrl}/api/auth/token`, {
            headers: { Origin: 'http://127.0.0.1:3030' }
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.token).toBe(token);
    });

    it('2. GET /gemini/status returns connected: true with dual-auth', async () => {
        const res = await fetch(`${baseUrl}/gemini/status`, {
            headers: { 'X-Scratchbox-Token': token }
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.connected).toBe(true);
        expect(['service-account', 'api-key']).toContain(data.authMethod);
    });

    it('3. POST /gemini/generate-stream generates SSE stream with dev origin or token', async () => {
        const res = await fetch(`${baseUrl}/gemini/generate-stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'http://127.0.0.1:3030'
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
