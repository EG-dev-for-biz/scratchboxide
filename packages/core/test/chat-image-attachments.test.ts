import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { persistChatImages, ChatImageAttachmentError, MAX_CHAT_IMAGES } from '../src/node/gemini/chat-image-attachments';
import { buildContents } from '../src/node/gemini/prompt-builder';
import { fitWithin } from '../src/browser/generative-canvas/hooks/useImageAttachments';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

// A real 1x1 PNG and the first bytes of a JPEG (SOI + APP0 marker).
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]).toString('base64');

describe('persistChatImages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chat-images-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('saves each image by content hash with the type read from its bytes', () => {
        const saved = persistChatImages([
            { mimeType: 'image/jpeg', data: PNG_1PX, name: 'facade.png' },   // claims JPEG, is PNG
            { mimeType: 'image/jpeg', data: JPEG_HEAD, name: 'detail.jpg' }
        ], dir);
        expect(saved).toHaveLength(2);
        expect(saved[0].mimeType).toBe('image/png');
        expect(saved[0].path!.endsWith('.png')).toBe(true);
        expect(fs.readFileSync(saved[0].path!).equals(Buffer.from(PNG_1PX, 'base64'))).toBe(true);
        expect(fs.readFileSync(saved[0].path!).readUInt32BE(0)).toBe(0x89504e47);
        expect(saved[1].mimeType).toBe('image/jpeg');
        expect(path.basename(saved[1].path!)).toMatch(/^[0-9a-f]{24}\.jpg$/);
        // The same bytes again land on the same file.
        expect(persistChatImages([{ mimeType: 'image/png', data: PNG_1PX }], dir)[0].path).toBe(saved[0].path);
    });

    it('rejects bytes that are not an image, empty data and too many images', () => {
        const text = Buffer.from('#!/bin/sh\necho not an image\n').toString('base64');
        expect(() => persistChatImages([{ mimeType: 'image/png', data: text, name: 'evil.png' }], dir))
            .toThrow(/evil\.png is not a PNG, JPEG, WebP or GIF image/);
        expect(() => persistChatImages([{ mimeType: 'image/png', data: '' }], dir)).toThrow(ChatImageAttachmentError);
        const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ mimeType: 'image/png', data: PNG_1PX }));
        expect(() => persistChatImages(many, dir)).toThrow(/At most 4 images/);
        expect(persistChatImages(undefined, dir)).toEqual([]);
    });
});

describe('buildContents with attached images', () => {
    it('puts each image on the user turn as an inline part after the text, naming where it was saved', () => {
        const request: GeminiGenerateRequest = {
            prompt: 'Build this building',
            images: [
                { mimeType: 'image/png', data: PNG_1PX, name: 'facade.png', path: '/ws/.scratchbox/attachments/abc.png' },
                { mimeType: 'image/jpeg', data: JPEG_HEAD, name: 'detail.jpg' }
            ]
        };
        const contents = buildContents(request);
        const user = contents[contents.length - 1];
        expect(user.role).toBe('user');
        expect(user.parts).toHaveLength(3);
        const text = user.parts![0].text!;
        expect(text.startsWith('Build this building')).toBe(true);
        expect(text).toContain('The user attached 2 images');
        expect(text).toContain('1. facade.png (saved at /ws/.scratchbox/attachments/abc.png)');
        expect(text).toContain('2. detail.jpg');
        expect(user.parts![1].inlineData).toEqual({ mimeType: 'image/png', data: PNG_1PX });
        expect(user.parts![2].inlineData).toEqual({ mimeType: 'image/jpeg', data: JPEG_HEAD });
    });

    it('leaves a text-only turn as one text part', () => {
        const contents = buildContents({ prompt: 'Just text' });
        const user = contents[contents.length - 1];
        expect(user.parts).toEqual([{ text: 'Just text' }]);
    });
});

describe('fitWithin', () => {
    it('scales the long edge down to the limit and never enlarges', () => {
        expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
        expect(fitWithin(3000, 6000, 2048)).toEqual({ width: 1024, height: 2048 });
        expect(fitWithin(640, 640, 2048)).toEqual({ width: 640, height: 640 });
    });
});
