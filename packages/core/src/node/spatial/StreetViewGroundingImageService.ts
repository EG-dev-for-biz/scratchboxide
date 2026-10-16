/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Maps Imagery Grounding API: redacted Street View images that are permitted as input to image and video
 * generation. Ordinary Street View Static API images are not; anything bound for a generative model must come
 * from here. Requires an allowlisted project with the Maps Management API enabled, called with OAuth (the
 * app's service account), not an API key.
 */

export type GroundingAspectRatio =
    | 'RATIO_1X1' | 'RATIO_2X3' | 'RATIO_3X2' | 'RATIO_3X4' | 'RATIO_4X3'
    | 'RATIO_4X5' | 'RATIO_5X4' | 'RATIO_9X16' | 'RATIO_16X9' | 'RATIO_21X9';

export const GROUNDING_ASPECT_RATIOS: readonly GroundingAspectRatio[] = [
    'RATIO_1X1', 'RATIO_2X3', 'RATIO_3X2', 'RATIO_3X4', 'RATIO_4X3',
    'RATIO_4X5', 'RATIO_5X4', 'RATIO_9X16', 'RATIO_16X9', 'RATIO_21X9'
];

/** The grounding API's pitch for a view aimed `elevationDeg` above the horizon (up positive): the API counts down as positive. */
export function groundingPitchForElevation(elevationDeg: number): number {
    return Math.max(-90, Math.min(90, -elevationDeg)) + 0; // + 0 turns -0 into 0
}

/** The elevation (up positive) a grounding pitch looks at. */
export function elevationForGroundingPitch(pitchDegree: number): number {
    return -pitchDegree + 0;
}

export interface GroundingImageRequest {
    panoId: string;
    /** Degrees clockwise from north (0 = north, 90 = east). */
    headingDegree?: number;
    /**
     * Degrees, in the API's own sign: POSITIVE looks DOWN, NEGATIVE looks UP (measured against the live endpoint:
     * +38 returned pavement, -34 returned a cornice and the spandrels), so +90 is straight down and -90 straight up.
     * The rest of the app speaks elevation (up positive, as streetViewForward does); convert with
     * groundingPitchForElevation at the call, never by hand.
     */
    pitchDegree?: number;
    /** Horizontal field of view, 0-90 degrees (API limit). */
    fovDegree?: number;
    aspectRatio?: GroundingAspectRatio;
}

export interface GroundingImage {
    image: Buffer;
    mimeType: string;
    panoId: string;
    headingDegree: number;
    pitchDegree: number;
    fovDegree: number;
}

export interface GooglePano {
    panoId: string;
    lat: number;
    lng: number;
    date?: string;
    copyright?: string;
}

export interface StreetViewGroundingDeps {
    /** OAuth access token for an allowlisted project (the app's service account). */
    getAccessToken: () => Promise<string>;
    /** Numeric project number of the allowlisted project. */
    getProjectNumber: () => Promise<string>;
    fetchImpl?: typeof fetch;
    /** Base delay between retries of transient failures (default 1500 ms). */
    retryDelayMs?: number;
}

/** Only Google's own captures are eligible; user-contributed photospheres are refused ("Pano is not published or eligible"). */
export function isGoogleCapture(copyright: string | undefined): boolean {
    return /©\s*Google\b/i.test(copyright || '');
}

export class StreetViewGroundingImageService {
    constructor(private readonly deps: StreetViewGroundingDeps) {}

    /** `signal` aborts the request in flight and any retry wait (it rejects with the signal's reason, or an AbortError). */
    async retrieveGroundingImage(req: GroundingImageRequest, signal?: AbortSignal): Promise<GroundingImage> {
        if (!req.panoId) throw new Error('retrieveGroundingImage: panoId is required.');
        const stopped = () => (signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Street View grounding request was stopped'), { name: 'AbortError' }));
        if (signal?.aborted) throw stopped();
        const headingDegree = req.headingDegree ?? 0;
        const pitchDegree = Math.max(-90, Math.min(90, req.pitchDegree ?? 0));
        const fovDegree = Math.max(1, Math.min(90, req.fovDegree ?? 90));
        const [token, projectNumber] = await Promise.all([this.deps.getAccessToken(), this.deps.getProjectNumber()]);
        const body: Record<string, unknown> = {
            project: `projects/${projectNumber}`,
            panoIdLocation: { panoId: req.panoId, headingDegree, pitchDegree, fovDegree }
        };
        if (req.aspectRatio) body.dimension = { aspectRatio: req.aspectRatio };

        const call = () => (this.deps.fetchImpl ?? fetch)(
            `https://mapmanagement.googleapis.com/v1/projects/${projectNumber}:retrieveGroundingImage`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Goog-User-Project': projectNumber
                },
                body: JSON.stringify(body),
                ...(signal ? { signal } : {})
            }
        );
        // The endpoint intermittently answers 503 "Deadline expired"; retry transient statuses with backoff.
        let res = await call();
        for (let attempt = 1; attempt <= 2 && [429, 500, 503].includes(res.status); attempt++) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, (this.deps.retryDelayMs ?? 1500) * attempt);
                const onAbort = () => { clearTimeout(timer); reject(stopped()); };
                signal?.addEventListener('abort', onAbort, { once: true });
            });
            res = await call();
        }
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        if (!res.ok) {
            const message = json?.error?.message || text.slice(0, 300);
            throw new Error(`Maps Imagery Grounding API ${res.status}: ${message}` +
                (/not published or eligible/i.test(message) ? ' (use a Google-captured panorama, not a user photosphere)' : ''));
        }
        const data = json?.redactedImage?.data;
        if (typeof data !== 'string' || !data) throw new Error('Maps Imagery Grounding API returned no image data.');
        return {
            image: Buffer.from(data, 'base64'),
            mimeType: json.redactedImage.mimeType || 'image/jpeg',
            panoId: req.panoId,
            headingDegree,
            pitchDegree,
            fovDegree
        };
    }

    /**
     * Nearest Google-captured panorama to a point. Street View metadata returns the single nearest pano, which in busy
     * places is often a user photosphere, so this also samples a small ring of nearby points.
     */
    static async findGooglePano(lat: number, lng: number, apiKey: string, fetchImpl: typeof fetch = fetch, ringMeters = [0, 25, 50, 100]): Promise<GooglePano> {
        if (!apiKey) throw new Error('A Google Maps API key is required to look up Street View panoramas.');
        const seen = new Set<string>();
        const mPerDegLat = 111_320, mPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
        for (const r of ringMeters) {
            const points = r === 0 ? [[0, 0]] : Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4) * r, Math.sin((i * Math.PI) / 4) * r]);
            for (const [east, north] of points) {
                const params = new URLSearchParams({
                    location: `${lat + north / mPerDegLat},${lng + east / mPerDegLng}`,
                    radius: '20', source: 'outdoor', key: apiKey
                });
                const res = await fetchImpl(`https://maps.googleapis.com/maps/api/streetview/metadata?${params}`);
                const meta: any = await res.json().catch(() => ({}));
                if (meta.status !== 'OK' || !meta.pano_id || seen.has(meta.pano_id)) continue;
                seen.add(meta.pano_id);
                if (isGoogleCapture(meta.copyright)) {
                    return { panoId: meta.pano_id, lat: meta.location?.lat, lng: meta.location?.lng, date: meta.date, copyright: meta.copyright };
                }
            }
        }
        throw new Error(`No Google-captured Street View panorama within ${ringMeters[ringMeters.length - 1]} m of ${lat},${lng} ` +
            `(${seen.size} nearby panorama(s) were user photospheres, which the grounding API does not serve).`);
    }
}

/**
 * The service wired to the app's service account: its OAuth token, and the numeric project number of its
 * project (looked up once; SCRATCHBOX_GROUNDING_PROJECT_NUMBER overrides it for another allowlisted project).
 */
export function createStreetViewGroundingImageService(
    auth: { getAccessToken(): Promise<{ token?: string | null } | unknown>; ensureAuth(): boolean; cachedProjectId?: string },
    fetchImpl: typeof fetch = fetch
): StreetViewGroundingImageService {
    const token = async (): Promise<string> => {
        if (!auth.ensureAuth()) throw new Error('Street View grounding needs the Google Cloud service account (none is configured).');
        const t = (await auth.getAccessToken()) as { token?: string | null };
        if (!t?.token) throw new Error('Could not get an OAuth token from the Google Cloud service account.');
        return t.token;
    };
    let projectNumber: Promise<string> | undefined;
    const lookupProjectNumber = async (): Promise<string> => {
        const override = process.env.SCRATCHBOX_GROUNDING_PROJECT_NUMBER?.trim();
        if (override) return override;
        const projectId = auth.cachedProjectId;
        if (!projectId) throw new Error('No Google Cloud project is configured for Street View grounding.');
        const res = await fetchImpl(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, {
            headers: { Authorization: `Bearer ${await token()}` }
        });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok || !json.projectNumber) {
            throw new Error(`Could not look up the project number of ${projectId} (${res.status}); set SCRATCHBOX_GROUNDING_PROJECT_NUMBER.`);
        }
        return String(json.projectNumber);
    };
    return new StreetViewGroundingImageService({
        getAccessToken: token,
        getProjectNumber: () => (projectNumber ??= lookupProjectNumber().catch(err => { projectNumber = undefined; throw err; })),
        fetchImpl
    });
}
