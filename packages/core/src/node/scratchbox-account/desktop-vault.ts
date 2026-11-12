/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where the scratchbox.ai refresh token and binding are kept (desktop-account.ts).
 *
 * - In the app (the server embedded in Electron): `EncryptedDesktopVault` with Electron's `safeStorage`, the OS keychain,
 *   in a private file under the app's user-data directory, replaced atomically. There is no plaintext fallback: Linux's
 *   `basic_text` backend and a locked or missing keychain are refused.
 * - In development (`npm run dev`: the server runs in its own Node process, where `safeStorage` does not exist):
 *   `KeyFileDesktopVault`, the key store's AES-256-GCM file (`~/.scratchbox/credentials.json`, or
 *   SCRATCHBOX_CREDENTIALS_FILE). It is used only outside Electron; inside Electron without `safeStorage` nothing is stored.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileKeyStore, type KeyStore } from '../key-store';
import type { DesktopVault, StoredDesktopGrant } from './desktop-account';

/** The part of Electron's `safeStorage` the vault uses; structural, so the core does not import Electron. */
export interface NativeEncryption {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?(): string;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

export class EncryptedDesktopVault implements DesktopVault {
    constructor(private readonly filename: string, private readonly encryption: NativeEncryption,
        private readonly platform: string = process.platform) {}

    assertAvailable(): void {
        const backend = this.platform === 'linux' ? this.encryption.getSelectedStorageBackend?.() : undefined;
        if (!this.encryption.isEncryptionAvailable() ||
            (this.platform === 'linux' && (!backend || backend === 'basic_text'))) {
            throw new Error('Secure OS credential storage is unavailable. Unlock the OS keychain before connecting Scratchbox.');
        }
    }

    async load(): Promise<StoredDesktopGrant | null> {
        try {
            const info = await fs.stat(this.filename);
            this.assertAvailable();
            if (info.size > 64 * 1024) throw new Error('Invalid credential file.');
            return JSON.parse(this.encryption.decryptString(await fs.readFile(this.filename)));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error('Saved Scratchbox credentials could not be unlocked. Unlock the OS keychain or connect again.');
        }
    }

    async save(grant: StoredDesktopGrant): Promise<void> {
        this.assertAvailable();
        await fs.mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
            const file = await fs.open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(this.encryption.encryptString(JSON.stringify(grant)));
                await file.sync();
            } finally { await file.close(); }
            await fs.rename(temporary, this.filename);
        } finally { await fs.rm(temporary, { force: true }); }
    }

    async clear(): Promise<void> { await fs.rm(this.filename, { force: true }); }
}

const DEV_KEYS = { service: 'scratchbox.ai', account: 'desktop-grant' } as const;

/** Development only: the grant in the key store's encrypted file (see the module comment). */
export class KeyFileDesktopVault implements DesktopVault {
    constructor(private readonly store: KeyStore = new FileKeyStore()) {}

    assertAvailable(): void { /* the key file is always writable for the developer's own account */ }

    async load(): Promise<StoredDesktopGrant | null> {
        const text = await this.store.getPassword(DEV_KEYS.service, DEV_KEYS.account);
        if (!text) return null;
        try { return JSON.parse(text) as StoredDesktopGrant; }
        catch { throw new Error('The saved Scratchbox connection is unreadable. Connect again.'); }
    }

    async save(grant: StoredDesktopGrant): Promise<void> {
        await this.store.setPassword(DEV_KEYS.service, DEV_KEYS.account, JSON.stringify(grant));
    }

    async clear(): Promise<void> { await this.store.deletePassword(DEV_KEYS.service, DEV_KEYS.account); }
}

const UNAVAILABLE: NativeEncryption = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('unavailable'); },
    decryptString: () => { throw new Error('unavailable'); },
};

/**
 * The vault for this process: the keychain when the embedding app passes `safeStorage`; inside Electron without it, a
 * vault that refuses (never a weaker store); outside Electron (development), the key file.
 */
export function createDesktopVault(options: { encryption?: NativeEncryption; dataDir?: string; inElectron?: boolean } = {}): DesktopVault {
    const inElectron = options.inElectron ?? !!process.versions.electron;
    const file = join(options.dataDir ?? '.', 'scratchbox-account', 'session.enc');
    if (options.encryption) return new EncryptedDesktopVault(file, options.encryption);
    if (inElectron) return new EncryptedDesktopVault(file, UNAVAILABLE);
    return new KeyFileDesktopVault();
}
