/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

/** The colour a CSS string or 0xRRGGBB number names, or undefined when it names none (three.js would silently pick white). */
export function resolveOverrideColor(value: unknown): THREE.Color | undefined {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 0xffffff ? new THREE.Color(value) : undefined;
    if (typeof value !== 'string') return undefined;
    const text = value.trim().toLowerCase();
    const known = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(text) || /^(rgb|hsl)a?\([^)]*\)$/.test(text)
        || Object.prototype.hasOwnProperty.call((THREE.Color as unknown as { NAMES: Record<string, number> }).NAMES, text);
    if (!known) return undefined;
    const c = new THREE.Color();
    c.setStyle(text);
    return c;
}
