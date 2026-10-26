/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_reference_images (gemini/tools/location-reference-tools.ts over spatial/search-grounded-reference.ts): each model
 * is asked with Google Search turned on for an image and a written account; the images are written and returned with
 * their queries and sources, labelled generated (search-grounded reference); a model that answers without an image is
 * skipped with why, and the call fails only when no model gives a reference. A stand-in client: nothing is called.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLocationReferenceHandler, LOCATION_REFERENCE_TOOL_NAME } from '../src/node/gemini/tools/location-reference-tools';
import { fetchGroundedReferences } from '../src/node/spatial/search-grounded-reference';
import { DEFAULT_TOOL_DECLARATIONS } from '../src/node/gemini/tools';
import { GEOSPATIAL_3D_PACK } from '../src/node/gemini/domain-tool-packs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function standIn(answers: Record<string, 'image' | 'text-only' | 'throw'>) {
    const requests: any[] = [];
    return {
        requests,
        client: {
            models: {
                async generateContent(req: any) {
                    requests.push(req);
                    const a = answers[req.model];
                    if (a === 'throw') throw new Error('quota exceeded');
                    const parts: any[] = [{ text: 'A lantern with arched windows, a small cupola and a finial; many raised ribs.' }];
                    if (a === 'image') parts.push({ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });
                    return { modelVersion: `${req.model}-001`, candidates: [{ finishReason: 'STOP', content: { parts }, groundingMetadata: { webSearchQueries: ['what is on top of Flinders Street Station dome'], groundingChunks: [{ web: { title: 'Flinders Street railway station', uri: 'https://example.org/fss' } }] } }] };
                }
            }
        }
    };
}

describe('location_reference_images', () => {
    it('asks each model with Google Search on, writes the images and returns them labelled generated with queries and sources', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-ref-'));
        const s = standIn({ 'gemini-3-pro-image': 'image', 'gemini-3.1-flash-image': 'text-only' });
        const handler = createLocationReferenceHandler({ client: async () => s.client, outputDir: dir });
        const out = await handler({ place: 'Flinders Street Station, Melbourne', subject: 'the dome and its lantern', view: 'from Flinders Street', questions: ['what stands on the lantern'] }, {} as never);
        expect(s.requests).toHaveLength(2);
        for (const r of s.requests) {
            expect(r.config.tools).toEqual([{ googleSearch: {} }]);
            expect(r.config.responseModalities).toEqual(['TEXT', 'IMAGE']);
            expect(r.contents[0].parts[0].text).toMatch(/Use Google Search to find real photographs of the dome and its lantern of Flinders Street Station, Melbourne.*seen from Flinders Street.*what stands on the lantern/s);
        }
        const p = out.resultPayload as any;
        expect(p.provenance).toMatchObject({ label: 'generated', basis: 'search-grounded reference' });
        expect(p.references).toHaveLength(1);
        expect(p.references[0]).toMatchObject({ model: 'gemini-3-pro-image', modelVersion: 'gemini-3-pro-image-001', queries: ['what is on top of Flinders Street Station dome'], sources: [{ title: 'Flinders Street railway station', uri: 'https://example.org/fss' }] });
        expect(fs.readFileSync(p.references[0].path).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(p.skipped).toEqual([{ model: 'gemini-3.1-flash-image', code: 'unsupported', reason: 'no image in the answer (STOP)' }]);
        expect(out.summaryResult).toMatch(/not measurements/);
    });

    it('fails, naming every model and why, when no model gives a reference', async () => {
        const s = standIn({ a: 'throw', b: 'text-only' });
        await expect(fetchGroundedReferences(s.client, { place: 'X', subject: 'y' }, { models: ['a', 'b'] })).rejects.toThrow(/a: quota exceeded; b: no image in the answer/);
        await expect(createLocationReferenceHandler({ client: async () => s.client })({ subject: 'y' }, {} as never)).rejects.toThrow(/place/);
    });

    it('is declared, handled and offered in the geospatial pack', () => {
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === LOCATION_REFERENCE_TOOL_NAME)).toBe(true);
        expect(GEOSPATIAL_3D_PACK.toolNames).toContain(LOCATION_REFERENCE_TOOL_NAME);
    });
});
