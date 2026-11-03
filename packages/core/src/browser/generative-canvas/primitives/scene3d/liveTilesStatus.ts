/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Whether live Google 3D Tiles can stream in this app window, and why not. The viewport streams them with the window's
 * own Maps key (Settings, else the key compiled into the build), not the server's; each chat turn carries the answer
 * (GeminiGenerateRequest.liveTilesUnavailable) so the model does not describe tiles the viewport cannot show.
 */
import { resolveMapsApiKey } from '../../services/google-maps-service';

/** The viewport's message when the window has no key; the reason and the fix. */
export const NO_MAPS_KEY_MESSAGE = 'Live Google 3D Tiles are not shown: this app window has no Google Maps API key, and Google refuses the tiles without one (HTTP 403). Add the key in Settings > MCP Tools > Maps API Key; the tiles load once it is saved.';

/** A tileset load in this window that failed, with the key it was made with; cleared when a tileset loads again. */
let lastFailure: { apiKey: string; message: string } | null = null;

/** syncTilesLayer reports each tileset outcome here. */
export interface LiveTilesWindowRecorder {
    failed(apiKey: string, message: string): void;
    loaded(): void;
}

export const liveTilesWindowRecorder: LiveTilesWindowRecorder = {
    failed: (apiKey, message) => { lastFailure = { apiKey, message }; },
    loaded: () => { lastFailure = null; }
};

/**
 * Why live tiles cannot load in this window's viewport, or undefined when nothing known stops them: no key, else the
 * last tileset failure made with the key the window has now (a key saved since may work, so it is not judged by it).
 */
export function liveTilesUnavailableReason(apiKey: string = resolveMapsApiKey()): string | undefined {
    if (!apiKey) return NO_MAPS_KEY_MESSAGE;
    return lastFailure && lastFailure.apiKey === apiKey ? lastFailure.message : undefined;
}
