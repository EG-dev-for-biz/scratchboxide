/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A scene's weather: the one place that turns a time of day, a date, cloud cover, haze and fog into what the viewport
 * draws (the sky dome, its sun, cloud layer and cloud shadows, and the fog: features.atmosphericScattering, read by
 * syncAtmosphere.ts). The viewport's Weather tool, the scene graph's Weather node and the chat's tools all write it
 * through applySceneWeather, so they never disagree.
 *
 * The sun:
 *  - at a place (the scene's geoAnchor, else its environment's latitude/longitude): the NOAA ephemeris for that date at
 *    that local mean solar time (solar-position.ts);
 *  - with no place: a plain sun path (east at 6:00, highest in the south at noon, west at 18:00, below the horizon at
 *    night), labelled as such, never an assumed location.
 *
 * No uninvited atmosphere (AGENTS.md 3.6): nothing here runs until someone sets the weather, except a real place's opening
 * sky (withLocationSceneWeather: every 3D Building, 3D Scene and 3D World, user decision 2026-11-02); clearing it restores
 * the sky the scene had before, and a scene whose weather was cleared keeps it cleared.
 */

import type { Scene3DData } from '../../canvas-types';
import { calculateNOAASolarPosition } from './solar-position';
import { instantAtLocalMeanSolarTime } from '../../../../common/coordinate/solarPosition';

export const SCENE_WEATHER_VERSION = 'scene-weather/1';

/** What the user sets. Every value is continuous: there are no weather types. */
export interface SceneWeather {
    /** Local (mean solar) time of day in hours, 0-24. */
    timeOfDay: number;
    /** The day (yyyy-mm-dd); absent = today. */
    date?: string;
    /** Fraction of the sky covered by cloud, 0-1. */
    cloudCover: number;
    /** Haze in the air, 0 (very clear) - 1 (thick haze). */
    haze: number;
    /** Ground fog, 0 (none) - 1 (thick). */
    fog: number;
}

/** The scene field: the weather, and what the scene had before it was first set (so clearing it restores that). */
export interface SceneWeatherState extends SceneWeather {
    version?: string;
    prior?: { atmosphericScattering?: unknown; skybox?: string; timeOfDay?: number };
}

export const DEFAULT_SCENE_WEATHER: SceneWeather = { timeOfDay: 14, cloudCover: 0, haze: 0.2, fog: 0 };

export interface WeatherSun {
    elevationDeg: number;
    azimuthDeg: number;
    /** 'ephemeris': the real sun at the scene's place and date; 'sun-path': the plain path used where no place is known. */
    source: 'ephemeris' | 'sun-path';
}

/** The phase of the day by the sun's elevation (civil twilight to -6 degrees). */
export type WeatherPhase = 'night' | 'twilight' | 'golden hour' | 'day';
export function weatherPhase(elevationDeg: number): WeatherPhase {
    if (elevationDeg < -6) return 'night';
    if (elevationDeg < 0) return 'twilight';
    if (elevationDeg < 8) return 'golden hour';
    return 'day';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Normalises a weather: every value in range, the time wrapped into 0-24. */
export function normalizeWeather(w: Partial<SceneWeather>): SceneWeather {
    const t = Number.isFinite(w.timeOfDay) ? ((w.timeOfDay as number) % 24 + 24) % 24 : DEFAULT_SCENE_WEATHER.timeOfDay;
    return {
        timeOfDay: t,
        ...(typeof w.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.date) ? { date: w.date } : {}),
        cloudCover: clamp(Number.isFinite(w.cloudCover) ? (w.cloudCover as number) : DEFAULT_SCENE_WEATHER.cloudCover, 0, 1),
        haze: clamp(Number.isFinite(w.haze) ? (w.haze as number) : DEFAULT_SCENE_WEATHER.haze, 0, 1),
        fog: clamp(Number.isFinite(w.fog) ? (w.fog as number) : DEFAULT_SCENE_WEATHER.fog, 0, 1)
    };
}

/** The scene's place: its geoAnchor, else its environment's (or sky config's) latitude and longitude. */
export function sceneLocation(scene: Partial<Scene3DData> | undefined): { lat: number; lng: number } | undefined {
    if (!scene) return undefined;
    const ok = (lat: unknown, lng: unknown) => typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
    if (scene.geoAnchor && ok(scene.geoAnchor.lat, scene.geoAnchor.lng)) return { lat: scene.geoAnchor.lat, lng: scene.geoAnchor.lng };
    const env = scene.environment;
    if (env && ok(env.latitude, env.longitude)) return { lat: env.latitude as number, lng: env.longitude as number };
    const atmo = scene.features?.atmosphericScattering;
    if (atmo && typeof atmo === 'object' && ok(atmo.latitude, atmo.longitude)) return { lat: atmo.latitude as number, lng: atmo.longitude as number };
    return undefined;
}

/** The day a weather names (UTC year, month index, day), today when it names none. */
function weatherDay(w: SceneWeather): [number, number, number] {
    if (w.date) { const [y, m, d] = w.date.split('-').map(Number); return [y, m - 1, d]; }
    const now = new Date();
    return [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
}

/** The sun for a weather, at the place when there is one (see the file comment). */
export function weatherSun(w: SceneWeather, location?: { lat: number; lng: number }): WeatherSun {
    if (location) {
        const [y, m, d] = weatherDay(w);
        const sol = calculateNOAASolarPosition(instantAtLocalMeanSolarTime(y, m, d, w.timeOfDay, location.lng), location.lat, location.lng);
        return { elevationDeg: sol.elevationDeg, azimuthDeg: sol.azimuthDeg, source: 'ephemeris' };
    }
    // the plain sun path: a half-day arc from east to west through the south, peaking at 60 degrees, below the horizon at night
    const h = (w.timeOfDay - 6) / 12;
    const elevationDeg = 60 * Math.sin(h * Math.PI);
    const azimuthDeg = ((90 + 180 * h) % 360 + 360) % 360;
    return { elevationDeg, azimuthDeg, source: 'sun-path' };
}

/** The aerial perspective's range for a haze (m): long in clear air, short in thick haze, a tenth of it in a studio scene. */
export function hazeRangeM(haze: number, large: boolean): number {
    const clear = large ? 2000 : 200, thick = large ? 80 : 8;
    return clear * Math.pow(thick / clear, clamp(haze, 0, 1));
}

/**
 * Whether a sky config's cloud shadows were asked for (the viewport draws them only then, and while they are on): set by a request (the cloud-shadow operator, the gaffer rig, the
 * atmosphere tool), not by the weather. A config the weather wrote carries its marker (`weather`), and the weather's own
 * cloud shadows, which before 2026-11-04 it switched on with the cloud cover, are not a request; a request made on such
 * a config marks it (`weather.cloudShadows`).
 */
export function cloudShadowsRequested(atmo: unknown): boolean {
    if (typeof atmo !== 'object' || atmo === null) return false;
    const a = atmo as { cloudShadowsEnabled?: unknown; weather?: { cloudShadows?: unknown } };
    // the mark outlives a clear sky, which turns the shadows off for a while
    return a.weather === undefined ? a.cloudShadowsEnabled === true : a.weather?.cloudShadows === true;
}

/** The scene's weather, when one is set. */
export function readSceneWeather(scene: Partial<Scene3DData> | undefined): SceneWeather | undefined {
    const w = (scene as { weather?: SceneWeatherState } | undefined)?.weather;
    return w ? normalizeWeather(w) : undefined;
}

/**
 * The scene with its weather set: the weather recorded on the scene, and the sky config the viewport draws written from
 * it (the multiple-scattering sky model, sun angles, cloud cover and density, cloud shadows, haze as turbidity, fog as an
 * exponential density), the skybox the atmospheric sky. Fields of the sky config the weather does not own are kept.
 */
export function applySceneWeather(scene: Scene3DData, weather: Partial<SceneWeather>): Scene3DData {
    const w = normalizeWeather({ ...(readSceneWeather(scene) ?? DEFAULT_SCENE_WEATHER), ...weather });
    const loc = sceneLocation(scene);
    const sun = weatherSun(w, loc);
    const prevState = (scene as { weather?: SceneWeatherState }).weather;
    const prevAtmo = scene.features?.atmosphericScattering;
    const prior = prevState?.prior ?? { atmosphericScattering: prevAtmo, skybox: scene.environment?.skybox, timeOfDay: scene.environment?.timeOfDay };
    // a district (a geo-anchored or tiled scene) is hundreds of metres across, a studio scene tens
    const large = !!(scene.geoAnchor || (scene as { tiles3d?: unknown }).tiles3d);
    // a splat world draws Gaussian splats, which write no depth and whose colours are final display values: the aerial
    // perspective pass would take them for sky and tone-map them a second time, washing the whole world out to white
    // (AerialPerspectiveEffect.ts), so a splat world gets the sky without it (the splats carry the photos' own haze)
    const splatWorld = !!(scene.splatUrl || (scene as { splatTilesetUrl?: string }).splatTilesetUrl);
    const base = typeof prevAtmo === 'object' && prevAtmo !== null ? prevAtmo : {};
    const atmosphericScattering = {
        ...base,
        enabled: true,
        // the native multiple-scattering clear sky (García Liñán's method, scratchbox_sky_ms.hpp; multiple-scattering-sky.ts): at the low sun
        // a real place opens under, the higher orders of scattering set the colour of the sky and of its light. The sun
        // elevation drives it, the haze sets its aerosol (the turbidity below, as an optical depth at 550 nm), and the
        // cloud cover stays the dome's cloud layer over it
        skyModel: 'multiple-scattering' as const,
        sunElevation: sun.elevationDeg,
        sunAzimuth: sun.azimuthDeg,
        timeOfDay: w.timeOfDay,
        ...(loc ? { latitude: loc.lat, longitude: loc.lng } : {}),
        cloudCoverage: w.cloudCover,
        cloudDensity: w.cloudCover > 0 ? 0.3 + 0.4 * w.cloudCover : 0,
        // the cloud shadows are a 2D noise pattern laid over every surface (AerialPerspectiveEffect.ts computeCloudShadow), not
        // the shadows of the clouds the sky draws: across a district it reads as a huge stain, so the weather never turns
        // them on (user decision, 2026-11-04); only an explicit request does (cloudShadowsRequested), and it is kept
        cloudShadowsEnabled: cloudShadowsRequested(base) && w.cloudCover > 0.05,
        turbidity: 2 + 8 * w.haze,
        // haze is in the air all around, not only in the sky: the aerial perspective pass (AerialPerspectiveEffect.ts)
        // fades every surface toward the sky's colour with distance, over a range that shortens as the haze thickens
        // (a district clears to about 2 km, thick haze to 80 m; a studio scene a tenth of that); on whenever the sky is,
        // except in a splat world (above)
        aerialPerspectiveEnabled: !splatWorld,
        aerialPerspectiveRange: hazeRangeM(w.haze, large),
        mie: 0.002 + 0.03 * w.haze,
        inscatteringIntensity: 1,
        fogDensity: w.fog > 0 ? w.fog * (large ? 0.002 : 0.04) : 0,
        weather: { version: SCENE_WEATHER_VERSION, sun: sun.source, ...(cloudShadowsRequested(base) ? { cloudShadows: true } : {}) }
    };
    const { weatherCleared: _cleared, ...rest } = scene as Scene3DData & { weatherCleared?: boolean };
    return {
        ...rest,
        weather: { ...w, version: SCENE_WEATHER_VERSION, prior },
        features: { ...(scene.features || {}), atmosphericScattering },
        environment: { ...(scene.environment || {}), skybox: 'sky', timeOfDay: w.timeOfDay }
    } as Scene3DData;
}

/**
 * The scene with its weather cleared: the sky it had before the weather was first set. It is marked `weatherCleared`, so a
 * location's opening sky (withLocationSceneWeather) is not put back when the scene is composed or opened again.
 */
export function clearSceneWeather(scene: Scene3DData): Scene3DData {
    const state = (scene as { weather?: SceneWeatherState }).weather;
    if (!state) return scene;
    const { weather: _w, ...kept } = scene as Scene3DData & { weather?: SceneWeatherState };
    const rest = { ...kept, weatherCleared: true };
    const features = { ...(scene.features || {}) } as Record<string, unknown>;
    if (state.prior?.atmosphericScattering === undefined) delete features.atmosphericScattering;
    else features.atmosphericScattering = state.prior.atmosphericScattering;
    const environment = { ...(scene.environment || {}) } as Record<string, unknown>;
    if (state.prior?.skybox === undefined) delete environment.skybox; else environment.skybox = state.prior.skybox;
    if (state.prior?.timeOfDay === undefined) delete environment.timeOfDay; else environment.timeOfDay = state.prior.timeOfDay;
    return { ...rest, features, environment } as Scene3DData;
}

/**
 * The afternoon time of day (local mean solar time, hours) at which the sun stands `elevationDeg` above the horizon at the
 * place on `date` (the plain sun path with no place), found by bisection on the sun's descent after its highest. A day
 * whose sun never climbs that high gives the time of its highest (the sun as high as it gets, still lower than asked); a
 * day it never sinks below it (polar summer) gives the latest time searched.
 */
export function afternoonTimeForSunElevation(elevationDeg: number, location?: { lat: number; lng: number }, date?: string): number {
    const at = (t: number) => weatherSun(normalizeWeather({ timeOfDay: t, date }), location).elevationDeg;
    // the sun's highest lies within an hour of 12:00 local mean solar time (the equation of time stays under 17 minutes)
    let noon = 12, highest = at(12);
    for (let t = 11; t <= 13; t += 0.05) { const e = at(t); if (e > highest) { highest = e; noon = t; } }
    if (highest <= elevationDeg) return noon;
    let lo = noon, hi = 23.99;
    if (at(hi) >= elevationDeg) return hi;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(mid) > elevationDeg) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}

/**
 * The sky a real place opens under (user decision 2026-11-02: every 3D Building, 3D Scene and 3D World): partly cloudy, with
 * the sun low in the afternoon, from the place's own ephemeris on the build's day. 20 degrees is the low late-day sun the
 * 3D Scene button already asked for (2026-10-21: high enough that shadows do not crush to black).
 */
export const LOCATION_SCENE_WEATHER = { sunElevationDeg: 20, cloudCover: 0.4, haze: 0.2, fog: 0 } as const;

/**
 * A location scene with its opening sky (LOCATION_SCENE_WEATHER) on `date` (yyyy-mm-dd), unless it has a weather of its own
 * or its weather was cleared. The weather records the sky the scene had before, so the Weather tool's Off goes back to it.
 */
export function withLocationSceneWeather(scene: Scene3DData, date: string): Scene3DData {
    if (readSceneWeather(scene) || (scene as { weatherCleared?: boolean }).weatherCleared) return scene;
    const { sunElevationDeg, cloudCover, haze, fog } = LOCATION_SCENE_WEATHER;
    return applySceneWeather(scene, { timeOfDay: afternoonTimeForSunElevation(sunElevationDeg, sceneLocation(scene), date), date, cloudCover, haze, fog });
}

/** The UTC day (yyyy-mm-dd) of an instant: the day a location's opening sky is computed for. */
export function weatherDateOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** "14:30" for 14.5 hours. */
export function formatTimeOfDay(hours: number): string {
    const mins = ((Math.round(hours * 60) % 1440) + 1440) % 1440;
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
