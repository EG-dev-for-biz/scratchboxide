/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Fast 32-bit PRNG (Mulberry32) for deterministic procedural world generation,
 * heightfield noise synthesis, and object scattering.
 */
export function createSeededRandom(seed: number = 1337): () => number {
    let s = (Math.floor(seed) || 1) >>> 0;
    return function next(): number {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deterministic integer range [min, max]
 */
export function seededRandomInt(rng: () => number, min: number, max: number): number {
    return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Deterministic float range [min, max)
 */
export function seededRandomFloat(rng: () => number, min: number, max: number): number {
    return min + rng() * (max - min);
}

/**
 * Deterministic choice from array
 */
export function seededChoice<T>(rng: () => number, items: T[]): T {
    if (!items || items.length === 0) {
        throw new Error('seededChoice requires non-empty array');
    }
    const idx = Math.floor(rng() * items.length);
    return items[idx];
}
