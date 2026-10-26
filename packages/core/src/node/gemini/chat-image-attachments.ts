/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatImageAttachment } from '../../common/gemini-protocol';

/** At most this many images per turn. */
export const MAX_CHAT_IMAGES = 4;
/** Largest decoded image accepted (the composer sends downscaled JPEGs well under this). */
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

const SIGNATURES: Array<{ mimeType: string; ext: string; matches: (b: Buffer) => boolean }> = [
    { mimeType: 'image/png', ext: 'png', matches: b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
    { mimeType: 'image/jpeg', ext: 'jpg', matches: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mimeType: 'image/webp', ext: 'webp', matches: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
    { mimeType: 'image/gif', ext: 'gif', matches: b => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' }
];

export class ChatImageAttachmentError extends Error {
    readonly code = 'chat_image_attachment_invalid';
}

/**
 * Checks each attached image (count, size, and that its bytes really are the image type it claims),
 * saves it as `<sha256>.<ext>` under `dir`, and returns the attachments with `path` set and the
 * MIME type taken from the bytes. Throws ChatImageAttachmentError naming the first bad image.
 */
export function persistChatImages(images: unknown, dir: string): ChatImageAttachment[] {
    if (!Array.isArray(images) || images.length === 0) return [];
    if (images.length > MAX_CHAT_IMAGES) {
        throw new ChatImageAttachmentError(`At most ${MAX_CHAT_IMAGES} images can be attached to one message (got ${images.length})`);
    }
    const saved: ChatImageAttachment[] = [];
    images.forEach((raw, index) => {
        const label = typeof raw?.name === 'string' && raw.name ? raw.name : `image ${index + 1}`;
        if (typeof raw?.data !== 'string' || raw.data.length === 0) {
            throw new ChatImageAttachmentError(`Attached ${label} has no image data`);
        }
        const bytes = Buffer.from(raw.data, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_CHAT_IMAGE_BYTES) {
            throw new ChatImageAttachmentError(`Attached ${label} is ${bytes.length} bytes; the limit is ${MAX_CHAT_IMAGE_BYTES}`);
        }
        const kind = SIGNATURES.find(s => s.matches(bytes));
        if (!kind) {
            throw new ChatImageAttachmentError(`Attached ${label} is not a PNG, JPEG, WebP or GIF image`);
        }
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${hash}.${kind.ext}`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
        saved.push({ mimeType: kind.mimeType, data: raw.data, name: label, path: file });
    });
    return saved;
}
