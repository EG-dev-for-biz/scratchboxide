import { describe, it, expect, vi } from 'vitest';
import {
    StreetViewRestyleService,
    buildStreetViewRestylePrompt,
    compositeWithinRegions,
    removedObjectRegions,
    STREET_VIEW_RESTYLE_MODEL
} from '../src/node/spatial/StreetViewRestyleService';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = pixel(x, y);
            rgba.set([r, g, b, 255], (y * width + x) * 4);
        }
    }
    return { width, height, rgba };
}

function fakeClient(parts: any[]) {
    const generateContent = vi.fn(async () => ({ candidates: [{ content: { parts } }] }));
    return { client: { models: { generateContent } } as any, generateContent };
}

describe('Street View restyle (ported from spce cleanStreetViewImage)', () => {
    it('asks for every vehicle and person to be removed without touching buildings or the camera', () => {
        const prompt = buildStreetViewRestylePrompt();
        expect(prompt).toContain('Erase and completely remove ALL vehicles');
        expect(prompt).toContain('ALL people, pedestrians');
        expect(prompt).toContain('Do not change, modify, or add any buildings, trees, structures, or the camera perspective.');
        expect(prompt).not.toMatch(/lighting at|overcast sky/);
    });

    it('appends the same lighting clauses as spce for weather and time of day', () => {
        expect(buildStreetViewRestylePrompt({ weather: 'overcast' })).toContain('overcast sky, highly diffuse scattered atmospheric lighting');
        const sunset = buildStreetViewRestylePrompt({ timeOfDay: 17.5, heading: 90 });
        expect(sunset).toContain('warm golden hour sunset lighting at 17:30 at a 12-degree angle');
        expect(sunset).toMatch(/with the sun positioned .+ to project clean, accurate shadow profiles/);
    });

    it('sends the image with the removal prompt and returns the model image', async () => {
        const { client, generateContent } = fakeClient([{ inlineData: { mimeType: 'image/png', data: Buffer.from('cleaned').toString('base64') } }]);
        const service = new StreetViewRestyleService({ client });
        const result = await service.restyle({ image: Buffer.from('raw-jpeg'), aspectRatio: '16:9' });

        expect(result.image.toString()).toBe('cleaned');
        expect(result.mimeType).toBe('image/png');
        expect(result.model).toBe(STREET_VIEW_RESTYLE_MODEL);
        const call = generateContent.mock.calls[0][0] as any;
        expect(call.model).toBe(STREET_VIEW_RESTYLE_MODEL);
        expect(call.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('raw-jpeg').toString('base64') });
        expect(call.contents[0].parts[1].text).toBe(buildStreetViewRestylePrompt());
        expect(call.config.responseModalities).toEqual(['IMAGE']);
        expect(call.config.imageConfig.aspectRatio).toBe('16:9');
    });

    it('keeps spce\'s 3:2 output aspect ratio unless the caller passes one', async () => {
        const { client, generateContent } = fakeClient([{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }]);
        await new StreetViewRestyleService({ client }).restyle({ image: Buffer.from('x') });
        expect((generateContent.mock.calls[0][0] as any).config.imageConfig.aspectRatio).toBe('3:2');
    });

    it('throws when the model returns no image', async () => {
        const { client } = fakeClient([{ text: 'I cannot do that' }]);
        await expect(new StreetViewRestyleService({ client }).restyle({ image: Buffer.from('x') }))
            .rejects.toThrow('No image data returned from Gemini for vehicle/pedestrian removal');
    });

    it('keeps the original frame outside the removed objects, re-aligning the cleaned patch', () => {
        const texture = (x: number, y: number): [number, number, number] => {
            const v = (x * 7 + y * 13) % 200 + 20;
            return [v, v, v];
        };
        const person = (x: number, y: number) => x >= 20 && x < 28 && y >= 18 && y < 30;
        const original = image(64, 48, (x, y) => person(x, y) ? [220, 30, 30] : texture(x, y));
        // Cleaned output: person removed, content shifted by (2, 1) px, and an invented band along the bottom.
        const cleaned = image(64, 48, (x, y) => y >= 40 ? [250, 250, 250] : texture(x - 2, y - 1));

        const out = compositeWithinRegions(original, cleaned, [{ x0: 17, y0: 15, x1: 31, y1: 33 }], { featherPx: 3, searchPx: 4 });
        const at = (x: number, y: number) => [...out.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3)];

        for (let y = 18; y < 30; y++) {
            for (let x = 20; x < 28; x++) {
                expect(at(x, y)).toEqual(texture(x, y));
            }
        }
        for (let x = 0; x < 64; x++) {
            expect(at(x, 44)).toEqual(texture(x, 44));
        }
        expect(at(2, 2)).toEqual(texture(2, 2));
        expect(at(60, 10)).toEqual(texture(60, 10));
        expect(() => compositeWithinRegions(original, image(32, 24, () => [0, 0, 0]), [])).toThrow(/same size/);
    });

    it('finds the removed object from the change inside a loose detection box, ignoring edits that reach the frame edge', () => {
        const base = (x: number, y: number): [number, number, number] => [90 + (x % 3), 90, 90];
        const person = (x: number, y: number) => x >= 100 && x < 116 && y >= 60 && y < 80;
        const original = image(200, 120, (x, y) => person(x, y) ? [20, 20, 20] : base(x, y));
        // Cleaned: person gone, plus an invented band along the bottom edge.
        const cleaned = image(200, 120, (x, y) => y >= 104 ? [200, 200, 200] : base(x, y));
        const looseBox = { x0: 40, y0: 40, x1: 180, y1: 120 };

        const regions = removedObjectRegions(original, cleaned, [looseBox], { marginPx: 6 });
        expect(regions).toHaveLength(1);
        const [r] = regions;
        expect(r.x0).toBeLessThanOrEqual(100);
        expect(r.x1).toBeGreaterThanOrEqual(116);
        expect(r.y0).toBeLessThanOrEqual(60);
        expect(r.y1).toBeGreaterThanOrEqual(80);
        expect(r.y1).toBeLessThan(100);
        expect(r.x1 - r.x0).toBeLessThan(40);
    });

    it('fetches Street View by panorama after checking coverage, and refuses when there is none', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn(async (url: string) => {
            calls.push(url);
            if (url.includes('/metadata?')) {
                return new Response(JSON.stringify({ status: 'OK', pano_id: 'PANO1', date: '2026-04', location: { lat: 40.764, lng: -73.974 }, copyright: '© Google' }));
            }
            return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
        });
        const shot = await StreetViewRestyleService.fetchStreetViewImage({ lat: 40.7646, lng: -73.9743, heading: 90, pitch: 10, apiKey: 'k', fetchImpl });
        expect(shot.panoId).toBe('PANO1');
        expect(shot.date).toBe('2026-04');
        expect(shot.image.length).toBe(3);
        expect(calls[1]).toContain('pano=PANO1');
        expect(calls[1]).toContain('size=600x400');
        expect(calls[1]).toContain('heading=90');

        const none = vi.fn(async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS' })));
        await expect(StreetViewRestyleService.fetchStreetViewImage({ lat: 0, lng: 0, apiKey: 'k', fetchImpl: none }))
            .rejects.toThrow(/No Street View coverage/);
        await expect(StreetViewRestyleService.fetchStreetViewImage({ lat: 0, lng: 0, apiKey: '', fetchImpl: none }))
            .rejects.toThrow(/API key/);
    });
});
