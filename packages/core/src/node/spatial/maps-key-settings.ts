/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { FileKeyStore } from '../key-store';
import { GoogleMapsService } from '../../browser/generative-canvas/services/google-maps-service';

/**
 * The Google Maps Platform key saved in Settings, on the server. Settings used to keep the key only in the
 * renderer's localStorage, so the chat tools (which run on the server) never saw it and failed with
 * "no Google Maps API key is configured" while Settings' own test passed. The key is kept in the encrypted key
 * store and applied to this process, where resolveMapsApiKey reads it.
 */
export const MAPS_KEY_STORE_SERVICE = 'scratchbox-ide.google-maps';
export const MAPS_KEY_STORE_ACCOUNT = 'api-key';

type MapsKeyStore = Pick<FileKeyStore, 'getPasswordSync' | 'setPassword' | 'deletePassword'>;

/** Makes `key` this process's Maps key (or clears the Settings key). */
function applyToProcess(key: string): void {
    if (key) {
        process.env.GOOGLE_MAPS_API_KEY = key;
    } else {
        delete process.env.GOOGLE_MAPS_API_KEY;
    }
    GoogleMapsService.getInstance().setApiKey(key || process.env.MAP_TILES_API_KEY || '');
}

/**
 * At startup: a key saved in Settings outranks one copied in from a secrets file (as for the Gemini key). Call only
 * when GOOGLE_MAPS_API_KEY was not set in the real environment, which still wins. Returns whether a key was applied.
 */
export function preferSavedMapsKey(keyStore: Pick<MapsKeyStore, 'getPasswordSync'> = new FileKeyStore()): boolean {
    const saved = keyStore.getPasswordSync(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT)?.trim();
    if (!saved) return false;
    if (process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== saved) {
        console.warn('[Scratchbox] Using the Google Maps API key saved in Settings instead of the one in the secrets file.');
    }
    applyToProcess(saved);
    return true;
}

/**
 * Saves the Settings key (an empty key clears it) and applies it to this process at once, so the next tool call
 * uses it. Clearing removes the saved key; a key from the real environment or a secrets file returns on restart.
 * Returns whether the server now has any Maps key. The key itself is never returned or logged.
 */
export async function saveMapsKeySetting(rawKey: string, keyStore: MapsKeyStore = new FileKeyStore()): Promise<{ configured: boolean }> {
    const key = (rawKey || '').trim();
    if (key) {
        await keyStore.setPassword(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT, key);
        applyToProcess(key);
    } else {
        const previous = keyStore.getPasswordSync(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT)?.trim();
        await keyStore.deletePassword(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT);
        if (previous && process.env.GOOGLE_MAPS_API_KEY === previous) applyToProcess('');
    }
    return { configured: !!(process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_TILES_API_KEY || GoogleMapsService.getInstance().getApiKey()) };
}
