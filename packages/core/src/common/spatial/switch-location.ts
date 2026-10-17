/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * "Switch location": when Google found several places for the text the user wrote, the staged build mounted the most
 * prominent one and carries the others. Each other place becomes a pill in the chat (the `[Label](prompt:...)` form
 * the chat renders as a clickable pill); clicking it sends a prompt that names the exact place (coordinates and
 * placeId, taken from Google's own result), so the build is redone there without geocoding the text again.
 */

/** A place Google returned, exactly as the geocoder reported it. */
export interface SwitchablePlace {
    name?: string;
    formattedAddress: string;
    lat: number;
    lng: number;
    placeId?: string;
    userRatingCount?: number;
}

/** The place a staged call is handed so it skips geocoding: the resolved place and the places still to offer. */
export interface ResolvedPlaceArg {
    lat: number;
    lng: number;
    formattedAddress: string;
    placeId?: string;
    elevation?: number;
    alternatives?: SwitchablePlace[];
}

/** The request settings a switched build keeps. */
export interface SwitchableRequest { query: string; isolate: boolean; radiusM?: number; trees: boolean; stageIntoActiveScene?: boolean }

export interface SwitchLocationPill { label: string; prompt: string; place: ResolvedPlaceArg }

/** "Central Park, Santa Clarita": the place's name and the locality that follows it in its address. */
export function switchLocationLabel(p: Pick<SwitchablePlace, 'name' | 'formattedAddress'>): string {
    const parts = p.formattedAddress.split(',').map(s => s.trim()).filter(Boolean);
    const name = p.name?.trim() || parts[0] || p.formattedAddress;
    const rest = parts.length && parts[0].toLowerCase().includes(name.toLowerCase()) ? parts.slice(1) : parts;
    const locality = rest.find(s => s.toLowerCase() !== name.toLowerCase());
    return locality ? `${name}, ${locality}` : name;
}

const roundCoord = (v: number) => Number(v.toFixed(6));

/**
 * One pill per other place. The pill's place carries the remaining choices, the place currently shown among them, so
 * the user can switch back.
 */
export function buildSwitchLocationPills(
    current: { formattedAddress: string; lat: number; lng: number; placeId?: string; name?: string; alternatives?: SwitchablePlace[] },
    request: SwitchableRequest
): SwitchLocationPill[] {
    const others = current.alternatives ?? [];
    if (!others.length) return [];
    const shown: SwitchablePlace = { formattedAddress: current.formattedAddress, lat: current.lat, lng: current.lng, ...(current.placeId ? { placeId: current.placeId } : {}), ...(current.name ? { name: current.name } : {}) };
    return others.map((alt, i) => {
        const place: ResolvedPlaceArg = {
            lat: roundCoord(alt.lat), lng: roundCoord(alt.lng), formattedAddress: alt.formattedAddress,
            ...(alt.placeId ? { placeId: alt.placeId } : {}),
            alternatives: [shown, ...others.filter((_, j) => j !== i)]
        };
        const label = switchLocationLabel(alt);
        const settings = [
            `isolate: ${request.isolate}`,
            ...(request.radiusM !== undefined && !request.isolate ? [`radiusMeters: ${request.radiusM}`] : []),
            `trees: ${request.trees}`,
            ...(request.stageIntoActiveScene ? ['stageIntoActiveScene: true'] : [])
        ].join(', ');
        const prompt =
            `Switch location to ${label} (${alt.formattedAddress}). Redo my request there: call google_3d_tiles_get_clay with query ${JSON.stringify(request.query)}, ` +
            `${settings}, and place ${JSON.stringify(place)} exactly as given, so the place is not looked up again. Keep everything else about my original request.`;
        return { label, prompt, place };
    });
}

/** The pills as chat markdown, one list item each; empty when there is nothing to switch to. */
export function switchLocationMarkdown(pills: SwitchLocationPill[]): string {
    if (!pills.length) return '';
    return pills.map(p => `- [${p.label.replace(/[\[\]]/g, '')}](prompt:${encodeURIComponent(p.prompt).replace(/\(/g, '%28').replace(/\)/g, '%29')})`).join('\n');
}
