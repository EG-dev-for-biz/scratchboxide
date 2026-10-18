import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import { buildMcpToolContext } from '../src/node/mcp/ScratchboxMcpServer';

describe('/gemini/tts synthesizes with the configured Gemini TTS model or refuses', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('refuses with a typed error when no TTS model is configured', async () => {
        vi.stubEnv('SCRATCHBOX_TTS_MODEL', '');
        const err = await new GeminiService().synthesizeSpeech({ text: 'hello' }).catch(e => e);
        expect(err).toBeInstanceOf(MediaModelUnavailableError);
        expect(err.code).toBe('media_model_unavailable');
    });

    it('sends the request to the model and wraps its PCM as WAV', async () => {
        vi.stubEnv('SCRATCHBOX_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
        vi.stubEnv('GEMINI_API_KEY', 'test-key-fetch-is-stubbed');
        const pcm = Buffer.alloc(4800, 7); // 0.1 s of 24 kHz mono 16-bit
        let sent: any;
        let url = '';
        vi.stubGlobal('fetch', async (u: string, init: any) => {
            url = String(u);
            sent = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }]
                }),
                text: async () => ''
            };
        });

        const res = await new GeminiService().synthesizeSpeech({ text: 'Mind the gap', voice: 'Kore', stylePrompt: 'Say calmly:', speed: 1.2 });
        expect(url).toContain('gemini-2.5-flash-preview-tts:generateContent');
        expect(sent.generationConfig.responseModalities).toEqual(['AUDIO']);
        expect(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
        const prompt = sent.contents[0].parts[0].text as string;
        expect(prompt).toContain('Mind the gap');
        expect(prompt).toContain('Say calmly:');
        expect(prompt).toContain('1.2x');

        expect(res.success).toBe(true);
        const wav = Buffer.from(res.audioContent!, 'base64');
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
        expect(wav.readUInt32LE(24)).toBe(24000);
        expect(wav.readUInt32LE(40)).toBe(pcm.length);
        expect(wav.subarray(44).equals(pcm)).toBe(true);
    });

    it('refuses when the model returns no audio', async () => {
        vi.stubEnv('SCRATCHBOX_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
        vi.stubEnv('GEMINI_API_KEY', 'test-key-fetch-is-stubbed');
        vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'OTHER' }] }), text: async () => '' }));
        await expect(new GeminiService().synthesizeSpeech({ text: 'hello' })).rejects.toBeInstanceOf(MediaModelUnavailableError);
    });
});

describe('MCP tool context has no fake IDE services', () => {
    it('sandbox commands throw instead of reporting exit 0', async () => {
        const ctx = buildMcpToolContext('/tmp/ws');
        expect(() => (ctx.sandbox as any).executeCommand('rm -rf build')).toThrow(/not available over MCP/);
        expect(() => (ctx.lsp as any).getDiagnostics('a.ts')).toThrow(/not available over MCP/);
        expect(() => (ctx.browserProxy as any).navigate('https://example.com')).toThrow(/not available over MCP/);
        expect((ctx.sandbox as any).workspaceRoot).toBe('/tmp/ws');
    });
});
