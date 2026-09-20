/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

/**
 * Converts a Kelvin color temperature (1000K to 40000K) into a THREE.Color.
 * Standard D65 daylight baseline is ~6500K.
 */
export function kelvinToRGB(kelvin: number): THREE.Color {
    const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;
    let r: number, g: number, b: number;

    if (temp <= 66) {
        r = 255;
        g = Math.max(0, Math.min(255, 99.4708025861 * Math.log(temp) - 161.1195681661));
        b = temp <= 19
            ? 0
            : Math.max(0, Math.min(255, 138.5177312231 * Math.log(temp - 10) - 305.0447927307));
    } else {
        r = Math.max(0, Math.min(255, 329.698727446 * Math.pow(temp - 60, -0.1332047592)));
        g = Math.max(0, Math.min(255, 288.1221695283 * Math.pow(temp - 60, -0.0755148492)));
        b = 255;
    }

    return new THREE.Color(r / 255, g / 255, b / 255);
}

/**
 * Converts a Kelvin color temperature into linear RGB tuple [r, g, b] in [0, 1].
 */
export function blackbodyKelvinToLinearRgb(kelvin: number): [number, number, number] {
    const col = kelvinToRGB(kelvin);
    return [col.r, col.g, col.b];
}
