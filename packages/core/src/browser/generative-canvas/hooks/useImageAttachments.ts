/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';

/** At most this many images per message (the server enforces the same limit). */
export const MAX_COMPOSER_IMAGES = 4;
/** Longest edge of the image sent to the model, in pixels. */
export const MAX_COMPOSER_IMAGE_EDGE = 2048;
/** Longest edge of the preview kept on the chat message. */
const PREVIEW_EDGE = 384;

/** An image attached in the composer: the downscaled JPEG sent with the turn plus a small preview. */
export interface ComposerImage {
    id: string;
    name: string;
    mimeType: 'image/jpeg';
    /** Base64 JPEG bytes, no data: prefix. */
    data: string;
    /** Small data: URL for the composer chip and the sent message. */
    previewUrl: string;
}

export function isImageFile(file: File): boolean {
    return /^image\/(png|jpe?g|webp|gif)$/i.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

/** The width and height that fit (w, h) inside a square of `maxEdge`, never enlarging. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
    const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function encodeJpeg(source: CanvasImageSource, w: number, h: number, maxEdge: number, quality: number): string {
    const size = fitWithin(w, h, maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw images to a canvas');
    // JPEG has no alpha: transparent areas become white rather than black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(source, 0, 0, size.width, size.height);
    return canvas.toDataURL('image/jpeg', quality);
}

async function toComposerImage(file: File): Promise<ComposerImage> {
    const bitmap = await createImageBitmap(file);
    try {
        const full = encodeJpeg(bitmap, bitmap.width, bitmap.height, MAX_COMPOSER_IMAGE_EDGE, 0.9);
        const previewUrl = encodeJpeg(bitmap, bitmap.width, bitmap.height, PREVIEW_EDGE, 0.8);
        return {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || 'pasted image',
            mimeType: 'image/jpeg',
            data: full.slice(full.indexOf(',') + 1),
            previewUrl
        };
    } finally {
        bitmap.close();
    }
}

export function useImageAttachments(showToast: (text: string, icon?: string) => void) {
    const [attachedImages, setAttachedImages] = React.useState<ComposerImage[]>([]);
    const countRef = React.useRef(0);
    countRef.current = attachedImages.length;

    const addImageFiles = React.useCallback(async (files: File[]) => {
        const images = files.filter(isImageFile);
        if (images.length === 0) return;
        const room = MAX_COMPOSER_IMAGES - countRef.current;
        if (room <= 0) {
            showToast(`At most ${MAX_COMPOSER_IMAGES} images per message`, '⚠️');
            return;
        }
        if (images.length > room) showToast(`Only the first ${room} image${room > 1 ? 's were' : ' was'} attached (limit ${MAX_COMPOSER_IMAGES})`, '⚠️');
        const added: ComposerImage[] = [];
        for (const file of images.slice(0, room)) {
            try {
                added.push(await toComposerImage(file));
            } catch (err: any) {
                showToast(`Could not read ${file.name || 'the image'}: ${err?.message || err}`, '⚠️');
            }
        }
        if (added.length > 0) {
            setAttachedImages(prev => [...prev, ...added].slice(0, MAX_COMPOSER_IMAGES));
            showToast(`Attached ${added.length} image${added.length > 1 ? 's' : ''}`, '🖼️');
        }
    }, [showToast]);

    const removeAttachedImage = React.useCallback((id: string) => {
        setAttachedImages(prev => prev.filter(img => img.id !== id));
    }, []);

    return { attachedImages, setAttachedImages, addImageFiles, removeAttachedImage };
}
