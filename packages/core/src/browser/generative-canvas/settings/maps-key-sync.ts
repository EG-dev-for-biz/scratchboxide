/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

const MAPS_KEY_ROUTE = '/api/geo/maps-key';

/**
 * Sends the Maps key Settings saved in this window to the server when the server has no Settings key. Settings used
 * to keep the key only in the window's storage, while the chat tools that look places up and fetch 3D Tiles run on
 * the server; a key saved that way would otherwise never reach them. Returns undefined when nothing needed sending
 * or the key was sent, else what went wrong, for Settings to show.
 */
export async function syncSavedMapsKeyToServer(savedKey: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
    const key = (savedKey || '').trim();
    if (!key) return undefined;
    try {
        const statusRes = await fetchImpl(MAPS_KEY_ROUTE, { headers: { Accept: 'application/json' } });
        if (!statusRes.ok) throw new Error(`checking the server's key returned HTTP ${statusRes.status}`);
        const status = await statusRes.json();
        if (status?.savedInSettings === true) return undefined;
        const res = await fetchImpl(MAPS_KEY_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ apiKey: key })
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body?.error || `saving the key returned HTTP ${res.status}`);
        }
        return undefined;
    } catch (err: any) {
        return `The Google Maps API key saved in Settings could not be sent to the server (${err?.message || String(err)}), so chat place lookups and 3D Tiles do not use it. Save the key again.`;
    }
}
