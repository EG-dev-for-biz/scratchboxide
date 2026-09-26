import { describe, it, expect, vi } from 'vitest';
import { OmniVideoService, buildBlockoutFirstLastPrompt, OMNI_VIDEO_MODEL } from '../src/node/video/OmniVideoService';

const png = (tag: string) => ({ data: Buffer.from(tag), mimeType: 'image/png' });
const mp4 = { data: Buffer.from('blockout-mp4'), mimeType: 'video/mp4' };
const videoStep = (data: string) => ({ type: 'model_output', content: [{ type: 'video', data: Buffer.from(data).toString('base64'), mime_type: 'video/mp4' }] });

function service(responses: Array<{ status?: number; body: unknown }>) {
    const requests: Array<{ url: string; init: any }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
        requests.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error('unexpected request ' + url);
        return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    });
    const svc = new OmniVideoService({
        fetchImpl: fetchImpl as any,
        getAccessToken: async () => 'token-123',
        project: 'proj',
        location: 'global',
        pollIntervalMs: 1
    });
    return { svc, requests };
}

describe('Omni video from a blockout with first and last frames', () => {
    it('writes the blockout prompt with frame roles, the continuity gate and empty streets', () => {
        const prompt = buildBlockoutFirstLastPrompt({ shot: 'Aerial descent down the hotel facade to a top-down view of the street.', emptyStreets: true });
        expect(prompt.startsWith('[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <VIDEO_REF_0>@Video1]')).toBe(true);
        expect(prompt).toContain('Single continuous shot, no scene cuts');
        expect(prompt).toContain('<VIDEO_REF_0>');
        expect(prompt).toContain('Aerial descent down the hotel facade');
        expect(prompt).toMatch(/no people.*no vehicles/i);
        expect(buildBlockoutFirstLastPrompt({ shot: 'x', emptyStreets: false })).not.toMatch(/no vehicles/i);
    });

    it('sends prompt, first frame, last frame and blockout video to Omni on Vertex and returns the video', async () => {
        const { svc, requests } = service([{ body: { id: 'int-1', status: 'completed', steps: [videoStep('omni-mp4')] } }]);
        const result = await svc.generate({ prompt: 'P', firstFrame: png('first'), lastFrame: png('last'), blockoutVideo: mp4 });

        expect(result.video.toString()).toBe('omni-mp4');
        expect(result.mimeType).toBe('video/mp4');
        expect(result.interactionId).toBe('int-1');
        expect(result.model).toBe(OMNI_VIDEO_MODEL);
        expect(requests[0].url).toBe('https://aiplatform.googleapis.com/v1beta1/projects/proj/locations/global/interactions');
        expect(requests[0].init.headers.Authorization).toBe('Bearer token-123');
        expect(requests[0].init.headers['Api-Revision']).toBe('2026-05-20');
        const body = JSON.parse(requests[0].init.body);
        expect(body.model).toBe('gemini-omni-1.1-flash-preview');
        expect(OMNI_VIDEO_MODEL).toBe('gemini-omni-1.1-flash-preview');
        expect(body.response_format).toEqual({ type: 'video' });
        expect(body).not.toHaveProperty('background');
        expect(body.input.map((c: any) => c.type)).toEqual(['text', 'image', 'image', 'video']);
        expect(body.input[0].text).toBe('P');
        expect(Buffer.from(body.input[1].data, 'base64').toString()).toBe('first');
        expect(Buffer.from(body.input[2].data, 'base64').toString()).toBe('last');
        expect(body.input[3]).toEqual({ type: 'video', mime_type: 'video/mp4', data: mp4.data.toString('base64') });
    });

    it('polls a queued interaction until it completes', async () => {
        const { svc, requests } = service([
            { body: { id: 'int-2', status: 'queued' } },
            { body: { id: 'int-2', status: 'in_progress' } },
            { body: { id: 'int-2', status: 'completed', steps: [{ type: 'thought', summary: [] }, videoStep('late-mp4')] } }
        ]);
        const result = await svc.generate({ prompt: 'P', blockoutVideo: mp4 });
        expect(result.video.toString()).toBe('late-mp4');
        expect(requests[1].url).toBe('https://aiplatform.googleapis.com/v1beta1/projects/proj/locations/global/interactions/int-2');
        expect(requests[1].init.method).toBe('GET');
        expect(requests).toHaveLength(3);
    });

    it('downloads the video when Omni returns a URI instead of inline data', async () => {
        const requests: string[] = [];
        const fetchImpl = vi.fn(async (url: string) => {
            requests.push(url);
            if (url.endsWith('/interactions')) {
                return new Response(JSON.stringify({ id: 'int-3', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'gs://bucket/out/v.mp4', mime_type: 'video/mp4' }] }] }));
            }
            return new Response(new Uint8Array([1, 2, 3]));
        });
        const svc = new OmniVideoService({ fetchImpl: fetchImpl as any, getAccessToken: async () => 't', project: 'p' });
        const result = await svc.generate({ prompt: 'P', blockoutVideo: mp4 });
        expect([...result.video]).toEqual([1, 2, 3]);
        expect(requests[1]).toBe('https://storage.googleapis.com/bucket/out/v.mp4');
    });

    it('throws instead of returning a stand-in when Omni fails or returns no video', async () => {
        const failed = service([{ body: { id: 'int-4', status: 'failed', error: { message: 'quota exhausted' } } }]);
        await expect(failed.svc.generate({ prompt: 'P', blockoutVideo: mp4 })).rejects.toThrow(/failed.*quota exhausted/);

        const empty = service([{ body: { id: 'int-5', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'sorry' }] }] } }]);
        await expect(empty.svc.generate({ prompt: 'P', blockoutVideo: mp4 })).rejects.toThrow(/no video/i);

        const http = service([{ status: 400, body: { error: { message: 'Unsupported model interaction' } } }]);
        await expect(http.svc.generate({ prompt: 'P', blockoutVideo: mp4 })).rejects.toThrow(/400.*Unsupported model interaction/);
    });
});
