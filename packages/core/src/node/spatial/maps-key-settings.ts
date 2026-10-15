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

/**
 * The key a Settings key replaced in this process (from the real environment or a secrets file), recorded the first
 * time a Settings key is applied, so that clearing the Settings key puts it back. Undefined while no Settings key is
 * applied.
 */
let replacedKey: { value: string | undefined } | undefined;

/** Makes the Settings key this process's Maps key, remembering the key it replaces. */
function applySettingsKey(key: string): void {
    if (!replacedKey) replacedKey = { value: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined };
    process.env.GOOGLE_MAPS_API_KEY = key;
    GoogleMapsService.getInstance().setApiKey(key);
}

/** Puts back the key the Settings key replaced (or none); does nothing when no Settings key was applied here. */
function restoreReplacedKey(): void {
    if (!replacedKey) return;
    const { value } = replacedKey;
    replacedKey = undefined;
    if (value) {
        process.env.GOOGLE_MAPS_API_KEY = value;
    } else {
        delete process.env.GOOGLE_MAPS_API_KEY;
    }
    GoogleMapsService.getInstance().setApiKey(value || process.env.MAP_TILES_API_KEY || '');
}

function anyMapsKeyConfigured(): boolean {
    return !!(process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_TILES_API_KEY || GoogleMapsService.getInstance().getApiKey());
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
    applySettingsKey(saved);
    return true;
}

/**
 * Saves the Settings key (an empty key clears it) and applies it to this process at once, so the next tool call
 * uses it. Clearing removes the saved key and puts back the key it replaced (from the real environment or a secrets
 * file), if there was one. Returns whether the server now has any Maps key. The key itself is never returned or logged.
 */
export async function saveMapsKeySetting(rawKey: string, keyStore: MapsKeyStore = new FileKeyStore()): Promise<{ configured: boolean }> {
    const key = (rawKey || '').trim();
    if (key) {
        await keyStore.setPassword(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT, key);
        applySettingsKey(key);
    } else {
        await keyStore.deletePassword(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT);
        restoreReplacedKey();
    }
    return { configured: anyMapsKeyConfigured() };
}

/**
 * Whether the server has any Maps key, and whether one is saved in Settings here. The renderer uses this to send a
 * key that Settings kept only in the window's storage (before the server kept one). The key itself is never returned.
 */
export function mapsKeyStatus(keyStore: Pick<MapsKeyStore, 'getPasswordSync'> = new FileKeyStore()): { configured: boolean; savedInSettings: boolean } {
    return {
        configured: anyMapsKeyConfigured(),
        savedInSettings: !!keyStore.getPasswordSync(MAPS_KEY_STORE_SERVICE, MAPS_KEY_STORE_ACCOUNT)?.trim()
    };
}
