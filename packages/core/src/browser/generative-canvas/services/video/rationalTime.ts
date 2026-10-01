/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Standard Tick Base for rational timeline representation.
 * Using 48,000 Hz (standard audio sample rate) as the baseline tick rate,
 * which cleanly divides 24, 25, 30, 48, 50, 60 fps and audio boundaries
 * with zero floating-point accumulation drift.
 */
export const TICKS_PER_SECOND = 48000;

export interface RationalTime {
    numerator: number;
    denominator: number;
}

function gcd(a: number, b: number): number {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
        const t = b;
        b = a % b;
        a = t;
    }
    return a || 1;
}

export function simplifyRational(time: RationalTime): RationalTime {
    if (time.numerator === 0) return { numerator: 0, denominator: time.denominator || 1 };
    const d = gcd(time.numerator, time.denominator);
    return { numerator: time.numerator / d, denominator: time.denominator / d };
}

export function frameToTime(frame: number, fps = 30): RationalTime {
    return { numerator: Math.round(frame), denominator: fps || 30 };
}

export function timeToFrame(time: RationalTime | number, fps = 30): number {
    if (typeof time === 'number') {
        return Math.round(time * fps);
    }
    if (!time.denominator) return 0;
    return Math.round((time.numerator * fps) / time.denominator);
}

export function secondsToRational(seconds: number, fps = 30): RationalTime {
    const frame = Math.round(seconds * fps);
    return { numerator: frame, denominator: fps || 30 };
}

export function rationalToSeconds(time: RationalTime): number {
    if (!time.denominator) return 0;
    return time.numerator / time.denominator;
}

export function addRational(a: RationalTime, b: RationalTime): RationalTime {
    const num = a.numerator * b.denominator + b.numerator * a.denominator;
    const den = a.denominator * b.denominator;
    return simplifyRational({ numerator: num, denominator: den });
}

export function subRational(a: RationalTime, b: RationalTime): RationalTime {
    const num = a.numerator * b.denominator - b.numerator * a.denominator;
    const den = a.denominator * b.denominator;
    return simplifyRational({ numerator: num, denominator: den });
}

export function snapToFrameSeconds(seconds: number, fps = 30): number {
    return Math.round(seconds * fps) / fps;
}

export function secondsToTicks(seconds: number): number {
    return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
    return ticks / TICKS_PER_SECOND;
}
