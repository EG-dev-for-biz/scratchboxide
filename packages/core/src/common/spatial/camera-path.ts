/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A camera move as keyed poses on the scene timeline: each key a time and a camera (position and target in metres, y
 * up, a lens in millimetres on a sensor of a given width, a frame aspect). Between keys the position and target follow a
 * cubic Hermite curve whose tangents are Catmull-Rom over the key times, so the path is smooth through every key, and
 * whose velocity is zero at the first and last key, so a move starts and settles gently. The focal length is
 * interpolated the same way in log space, so a zoom reads as even. Nothing names a kind of move: a push-in, a crane, an
 * orbit are all just keys.
 */

export type Vec3 = [number, number, number];

export interface CameraPathKey {
    timeMs: number;
    position: Vec3;
    target: Vec3;
    focalMm: number;
    /** Default 36 (full frame). */
    sensorWidthMm?: number;
    /** Frame width over height; default 16 / 9. */
    aspect?: number;
}

export interface CameraPose {
    position: Vec3;
    target: Vec3;
    focalMm: number;
    sensorWidthMm: number;
    aspect: number;
    /** Vertical field of view of the lens on the sensor at the aspect, degrees. */
    verticalFovDeg: number;
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The complete keys of a stored path, sorted by time, one per time (the last given wins). */
export function normalizeCameraKeys(raw: unknown): CameraPathKey[] {
    if (!Array.isArray(raw)) return [];
    const byTime = new Map<number, CameraPathKey>();
    for (const k of raw as Array<Record<string, unknown>>) {
        if (!k || typeof k.timeMs !== 'number' || !Number.isFinite(k.timeMs) || k.timeMs < 0) continue;
        if (!isVec3(k.position) || !isVec3(k.target) || !positive(k.focalMm)) continue;
        if (k.position.every((v, i) => v === (k.target as Vec3)[i])) continue;
        byTime.set(k.timeMs, {
            timeMs: k.timeMs, position: k.position, target: k.target, focalMm: k.focalMm,
            ...(positive(k.sensorWidthMm) ? { sensorWidthMm: k.sensorWidthMm } : {}),
            ...(positive(k.aspect) ? { aspect: k.aspect } : {})
        });
    }
    return [...byTime.values()].sort((a, b) => a.timeMs - b.timeMs);
}

export function verticalFovDegOf(focalMm: number, sensorWidthMm: number, aspect: number): number {
    return 2 * Math.atan(sensorWidthMm / aspect / (2 * focalMm)) * 180 / Math.PI;
}

/** Hermite basis on [0, 1] for values a, b with tangents ma, mb already scaled by the span. */
function hermite(a: number, b: number, ma: number, mb: number, s: number): number {
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * a + (s3 - 2 * s2 + s) * ma + (-2 * s3 + 3 * s2) * b + (s3 - s2) * mb;
}

/** Tangent (per millisecond) of a scalar channel at key i: Catmull-Rom over the key times, zero at the ends. */
function tangent(keys: CameraPathKey[], i: number, value: (k: CameraPathKey) => number): number {
    if (i === 0 || i === keys.length - 1) return 0;
    const dt = keys[i + 1].timeMs - keys[i - 1].timeMs;
    return dt > 0 ? (value(keys[i + 1]) - value(keys[i - 1])) / dt : 0;
}

/**
 * The camera at time tMs on the path: the first key's pose before it, the last key's after it. Null for no keys.
 */
export function cameraPoseAt(keysIn: CameraPathKey[], tMs: number): CameraPose | null {
    const keys = normalizeCameraKeys(keysIn);
    if (!keys.length) return null;
    const pose = (position: Vec3, target: Vec3, focalMm: number, sensorWidthMm: number, aspect: number): CameraPose =>
        ({ position, target, focalMm, sensorWidthMm, aspect, verticalFovDeg: verticalFovDegOf(focalMm, sensorWidthMm, aspect) });
    const sensorOf = (k: CameraPathKey) => k.sensorWidthMm ?? 36;
    const aspectOf = (k: CameraPathKey) => k.aspect ?? 16 / 9;
    if (keys.length === 1 || tMs <= keys[0].timeMs) {
        const k = keys[0];
        return pose([...k.position], [...k.target], k.focalMm, sensorOf(k), aspectOf(k));
    }
    const last = keys[keys.length - 1];
    if (tMs >= last.timeMs) return pose([...last.position], [...last.target], last.focalMm, sensorOf(last), aspectOf(last));
    let i = 0;
    while (keys[i + 1].timeMs <= tMs) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.timeMs - a.timeMs;
    const s = (tMs - a.timeMs) / span;
    const channel = (value: (k: CameraPathKey) => number) =>
        hermite(value(a), value(b), tangent(keys, i, value) * span, tangent(keys, i + 1, value) * span, s);
    const vec = (pick: (k: CameraPathKey) => Vec3): Vec3 => [0, 1, 2].map(c => channel(k => pick(k)[c])) as Vec3;
    const focal = Math.exp(channel(k => Math.log(k.focalMm)));
    // the frame's own shape and sensor do not tween: they follow the key the segment starts from
    return pose(vec(k => k.position), vec(k => k.target), focal, sensorOf(a), aspectOf(a));
}

/** The path's length in time: its last key's time (0 for none). */
export function cameraPathDurationMs(keys: CameraPathKey[]): number {
    const k = normalizeCameraKeys(keys);
    return k.length ? k[k.length - 1].timeMs : 0;
}
