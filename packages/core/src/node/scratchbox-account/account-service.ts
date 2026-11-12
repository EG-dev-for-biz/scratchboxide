/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The server's one scratchbox.ai account (desktop-account.ts). The embedding app configures it once with its secure
 * storage (Electron passes `safeStorage` and its user-data directory); development falls back to the key file
 * (desktop-vault.ts). The saved connection is restored at once, without a network call.
 */

import { DesktopAccount, accountOrigin } from './desktop-account';
import { createDesktopVault, type NativeEncryption } from './desktop-vault';

export interface ScratchboxAccountSetup {
    encryption?: NativeEncryption;
    dataDir?: string;
    env?: Record<string, string | undefined>;
}

let shared: DesktopAccount | undefined;

export function configureScratchboxAccount(setup: ScratchboxAccountSetup = {}): DesktopAccount {
    shared?.close();
    const account = new DesktopAccount({
        origin: accountOrigin(setup.env),
        vault: createDesktopVault({ ...(setup.encryption ? { encryption: setup.encryption } : {}), ...(setup.dataDir ? { dataDir: setup.dataDir } : {}) }),
    });
    // A locked keychain or unreadable file is reported by the status (its reason); the server starts regardless.
    void account.restore().catch(() => undefined);
    shared = account;
    return account;
}

/** The account, configured with defaults (development) when the embedding app has not configured it. */
export function getScratchboxAccount(): DesktopAccount {
    return shared ?? configureScratchboxAccount();
}

/** Stops a sign-in in progress on shutdown (a settled saved connection stays); nothing when no account was configured. */
export function closeScratchboxAccount(): void {
    shared?.close();
}
