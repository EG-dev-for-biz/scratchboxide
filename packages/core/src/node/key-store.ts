/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

/**
 * Minimal credential store contract. Mirrors the subset of the OS keychain
 * API the services need so the Electron shell can plug in `safeStorage`
 * while tests and the plain Node server fall back to an encrypted file.
 */
export interface KeyStore {
    getPassword(service: string, account: string): Promise<string | undefined>;
    setPassword(service: string, account: string, password: string): Promise<void>;
    deletePassword(service: string, account: string): Promise<boolean>;
}

export interface KeyStoreCipher {
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
}

export interface FileKeyStoreOptions {
    /** Defaults to `~/.scratchbox/credentials.json`. */
    filePath?: string;
    /** Optional cipher (e.g. Electron `safeStorage`). Defaults to a machine-scoped AES-256-GCM key. */
    cipher?: KeyStoreCipher;
}

export function defaultCredentialsPath(): string {
    return path.join(os.homedir(), '.scratchbox', 'credentials.json');
}

/**
 * Machine-scoped AES-256-GCM cipher. The key is derived from stable host
 * identifiers so the file is unreadable when copied to another machine or
 * user account, without requiring a native keychain dependency.
 */
class LocalAesCipher implements KeyStoreCipher {
    private readonly key: Buffer;

    constructor() {
        const material = `${os.hostname()}|${os.userInfo().username}|${os.homedir()}|scratchbox-ide`;
        this.key = crypto.createHash('sha256').update(material).digest();
    }

    encrypt(plaintext: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
    }

    decrypt(ciphertext: string): string {
        const [version, ivB64, tagB64, bodyB64] = ciphertext.split(':');
        if (version !== 'v1' || !ivB64 || !tagB64 || !bodyB64) {
            throw new Error('Unrecognized credential encoding');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf8');
    }
}

export class FileKeyStore implements KeyStore {
    private readonly filePath: string;
    private readonly cipher: KeyStoreCipher;

    constructor(options: FileKeyStoreOptions = {}) {
        this.filePath = options.filePath || defaultCredentialsPath();
        this.cipher = options.cipher || new LocalAesCipher();
    }

    async getPassword(service: string, account: string): Promise<string | undefined> {
        const data = await this.read();
        const stored = data[this.slot(service, account)];
        if (!stored) {
            return undefined;
        }
        try {
            return this.cipher.decrypt(stored);
        } catch {
            return undefined;
        }
    }

    async setPassword(service: string, account: string, password: string): Promise<void> {
        const data = await this.read();
        data[this.slot(service, account)] = this.cipher.encrypt(password);
        await this.write(data);
    }

    async deletePassword(service: string, account: string): Promise<boolean> {
        const data = await this.read();
        const key = this.slot(service, account);
        if (!(key in data)) {
            return false;
        }
        delete data[key];
        await this.write(data);
        return true;
    }

    private slot(service: string, account: string): string {
        return `${service}/${account}`;
    }

    private async read(): Promise<Record<string, string>> {
        try {
            const json = await fs.readJSON(this.filePath);
            return json && typeof json === 'object' ? json : {};
        } catch {
            return {};
        }
    }

    private async write(data: Record<string, string>): Promise<void> {
        await fs.ensureDir(path.dirname(this.filePath), { mode: 0o700 });
        await fs.writeJSON(this.filePath, data, { spaces: 2, mode: 0o600 });
        await fs.chmod(this.filePath, 0o600);
    }
}
