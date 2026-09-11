/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash } from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import { MediaAssetRef } from '../common/media-generation-protocol';

const MIME_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm'
};

const MAX_ASSET_BYTES = 512 * 1024 * 1024;

@injectable()
export class MediaAssetStore {
    async put(workspaceRoot: string, bytes: Buffer, mimeType: string): Promise<MediaAssetRef> {
        const extension = MIME_EXTENSIONS[mimeType];
        if (!extension) {
            throw new Error(`Unsupported media MIME type: ${mimeType || 'unknown'}`);
        }
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
            throw new Error('Generated media bytes are empty');
        }
        if (bytes.length > MAX_ASSET_BYTES) {
            throw new Error(`Generated media exceeds ${MAX_ASSET_BYTES} byte limit`);
        }

        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const relativePath = path.join('.scratchbox', 'media', `${contentHash}.${extension}`);
        const destination = this.resolveWorkspacePath(workspaceRoot, relativePath);
        await fs.ensureDir(path.dirname(destination));

        if (!await fs.pathExists(destination)) {
            const temporaryPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temporaryPath, bytes, { mode: 0o600 });
            try {
                await fs.rename(temporaryPath, destination);
            } catch (error) {
                await fs.remove(temporaryPath);
                if (!await fs.pathExists(destination)) {
                    throw error;
                }
            }
        }

        return {
            uri: `scratchbox-media://${contentHash}`,
            contentHash,
            mimeType,
            byteLength: bytes.length,
            relativePath
        };
    }

    resolve(workspaceRoot: string, asset: MediaAssetRef): string {
        if (!/^[a-f0-9]{64}$/.test(asset.contentHash)) {
            throw new Error('Invalid media content hash');
        }
        const expectedPrefix = path.join('.scratchbox', 'media', `${asset.contentHash}.`);
        if (!asset.relativePath.startsWith(expectedPrefix)) {
            throw new Error('Invalid media path outside the content-addressed store');
        }
        return this.resolveWorkspacePath(workspaceRoot, asset.relativePath);
    }

    stagingPath(workspaceRoot: string, name: string): string {
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '-');
        if (!safeName || safeName === '.' || safeName === '..') {
            throw new Error('Invalid media staging filename');
        }
        return this.resolveWorkspacePath(workspaceRoot, path.join('.scratchbox', 'media', `.staging-${safeName}`));
    }

    private resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
        const root = path.resolve(workspaceRoot);
        const mediaRoot = path.resolve(root, '.scratchbox', 'media');
        const resolved = path.resolve(root, relativePath);
        if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) {
            throw new Error('Media path resolves outside the workspace media store');
        }
        return resolved;
    }
}
