import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GeminiService } from '../src/node/gemini-service';
import { READ_ONLY_TOOLS } from '../src/node/gemini/tool-permissions';

const realFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = realFetch; });

const sse = (part: object) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

describe('invoke_subagent', () => {
    it('runs a read-only agent with a fresh context and returns only its report', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sub-'));
        await fs.writeFile(path.join(root, 'config.ts'), 'export const LEG_COUNT = 4;\n');

        const service = new GeminiService();
        (service as any).auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 'mock-token' }) }) };
        (service as any).cachedProjectId = 'mock-project';

        const bodies: any[] = [];
        let subagentOfferedTools: string[] = [];
        let subagentSawParentChat = false;
        let subagentUrl = '';
        (globalThis as any).fetch = async (url: string, opts: any) => {
            const body = JSON.parse(opts.body);
            bodies.push(body);
            const text = JSON.stringify(body.contents);
            const isSub = text.includes('You are a research subagent');
            if (isSub) {
                subagentUrl = url;
                subagentOfferedTools = (body.tools || []).flatMap((t: any) => (t.functionDeclarations || []).map((d: any) => d.name));
                subagentSawParentChat = text.includes('PARENT-ONLY-SECRET');
                const alreadyRead = text.includes('LEG_COUNT');
                return { ok: true, body: null, text: async () => alreadyRead
                    ? sse({ text: 'LEG_COUNT is 4 (config.ts:1).' })
                    : sse({ functionCall: { name: 'workspace_read_file', args: { filePath: 'config.ts' } } }) };
            }
            const delegated = text.includes('LEG_COUNT is 4');
            return { ok: true, body: null, text: async () => delegated
                ? sse({ text: 'The stool has 4 legs.' })
                : sse({ functionCall: { name: 'invoke_subagent', args: { role: 'Researcher', prompt: 'What is LEG_COUNT?' } } }) };
        };

        const response = await service.streamGenerate({
            prompt: 'How many legs? PARENT-ONLY-SECRET', model: 'gemini-3.7-flash', mode: 'agent', workspaceRoot: root
        }, () => undefined);

        expect(response.success).toBe(true);
        expect(response.text).toContain('4 legs');
        expect(subagentOfferedTools).toContain('workspace_read_file');
        expect(subagentOfferedTools.filter(n => !READ_ONLY_TOOLS.has(n))).toEqual([]);
        expect(subagentOfferedTools).not.toContain('workspace_write_file');
        expect(subagentOfferedTools).not.toContain('invoke_subagent');
        expect(subagentSawParentChat).toBe(false);
        expect(subagentUrl).toContain('gemini-3.5-flash-lite');
    });
});
