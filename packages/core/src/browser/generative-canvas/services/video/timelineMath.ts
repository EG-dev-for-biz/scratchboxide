/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TimelineElement, PropertyKeyframe } from './videoTypes';
import { snapToFrameSeconds } from './rationalTime';

/**
 * Checks if a playhead (in seconds) falls within an element's timeline bounds.
 */
export function isPlayheadInElement(element: TimelineElement, playhead: number): boolean {
    const end = element.startTime + element.duration;
    return playhead >= element.startTime && playhead < end;
}

/**
 * Maps timeline playhead position into local source media time.
 */
export function getLocalMediaTime(element: TimelineElement, playhead: number): number {
    const offsetInClip = playhead - element.startTime;
    const speed = element.speed || 1.0;
    const mediaOffset = offsetInClip * speed;
    return element.trimStart + (element.reverse ? (element.duration * speed - mediaOffset) : mediaOffset);
}

/**
 * Sort elements by start time ascending.
 */
export function sortElements(elements: TimelineElement[]): TimelineElement[] {
    return [...elements].sort((a, b) => a.startTime - b.startTime);
}

/**
 * Moves an element to a new start time, snapped to frame boundaries.
 */
export function moveElement(
    elements: TimelineElement[],
    elementId: string,
    newStartTime: number,
    fps = 30
): TimelineElement[] {
    const safeStart = Math.max(0, snapToFrameSeconds(newStartTime, fps));
    return elements.map(el => {
        if (el.id !== elementId) return el;
        return {
            ...el,
            startTime: safeStart
        };
    });
}

/**
 * Trims the head (in-point) of an element, preserving the tail end time.
 */
export function trimElementHead(
    elements: TimelineElement[],
    elementId: string,
    newStartTime: number,
    fps = 30
): TimelineElement[] {
    return elements.map(el => {
        if (el.id !== elementId) return el;

        const currentEnd = el.startTime + el.duration;
        const safeStart = snapToFrameSeconds(newStartTime, fps);

        // Clamp so clip has at least 1 frame duration
        const minDuration = 1 / fps;
        const clampedStart = Math.min(Math.max(0, safeStart), currentEnd - minDuration);
        const delta = clampedStart - el.startTime;
        const newDuration = currentEnd - clampedStart;
        const newTrimStart = Math.max(0, el.trimStart + delta);

        return {
            ...el,
            startTime: clampedStart,
            duration: Math.max(minDuration, newDuration),
            trimStart: newTrimStart
        };
    });
}

/**
 * Trims the tail (out-point) of an element.
 */
export function trimElementTail(
    elements: TimelineElement[],
    elementId: string,
    newDuration: number,
    fps = 30
): TimelineElement[] {
    const minDuration = 1 / fps;
    return elements.map(el => {
        if (el.id !== elementId) return el;

        const safeDuration = Math.max(minDuration, snapToFrameSeconds(newDuration, fps));
        const delta = safeDuration - el.duration;
        const newTrimEnd = Math.max(0, el.trimEnd + delta);

        return {
            ...el,
            duration: safeDuration,
            trimEnd: newTrimEnd
        };
    });
}

/**
 * Razor split an element at a specific playhead time into two adjacent clips.
 */
export function splitElementAtTime(
    elements: TimelineElement[],
    elementId: string,
    splitTime: number,
    fps = 30
): TimelineElement[] {
    const target = elements.find(el => el.id === elementId);
    if (!target) return elements;

    const safeSplit = snapToFrameSeconds(splitTime, fps);
    const minDuration = 1 / fps;

    // Split time must be strictly inside the clip
    if (safeSplit <= target.startTime + minDuration || safeSplit >= target.startTime + target.duration - minDuration) {
        return elements;
    }

    const firstDuration = safeSplit - target.startTime;
    const secondDuration = target.duration - firstDuration;
    const speed = target.speed || 1.0;
    const mediaConsumed = firstDuration * speed;

    const firstClip: TimelineElement = {
        ...target,
        duration: firstDuration,
        trimEnd: target.trimStart + mediaConsumed
    };

    const secondClip: TimelineElement = {
        ...target,
        id: `${target.id}-split-${Date.now()}`,
        name: `${target.name} (Part 2)`,
        startTime: safeSplit,
        duration: secondDuration,
        trimStart: target.trimStart + mediaConsumed
    };

    return elements.flatMap(el => (el.id === elementId ? [firstClip, secondClip] : [el]));
}

/**
 * Slips source media in/out points while keeping the clip's timeline position and duration constant.
 */
export function slipElement(
    elements: TimelineElement[],
    elementId: string,
    deltaSeconds: number,
    fps = 30,
    maxSourceDuration?: number
): TimelineElement[] {
    return elements.map(el => {
        if (el.id !== elementId) return el;

        const delta = snapToFrameSeconds(deltaSeconds, fps);
        let newTrimStart = el.trimStart + delta;
        let newTrimEnd = el.trimEnd + delta;

        if (newTrimStart < 0) {
            newTrimEnd -= newTrimStart;
            newTrimStart = 0;
        }

        if (maxSourceDuration && newTrimEnd > maxSourceDuration) {
            const overflow = newTrimEnd - maxSourceDuration;
            newTrimEnd = maxSourceDuration;
            newTrimStart = Math.max(0, newTrimStart - overflow);
        }

        return {
            ...el,
            trimStart: newTrimStart,
            trimEnd: newTrimEnd
        };
    });
}

/**
 * Slides an element along the timeline between its neighbors, trimming the preceding clip and extending the following clip.
 */
export function slideElement(
    elements: TimelineElement[],
    elementId: string,
    deltaSeconds: number,
    fps = 30
): TimelineElement[] {
    const sorted = sortElements(elements);
    const idx = sorted.findIndex(el => el.id === elementId);
    if (idx === -1) return elements;

    const target = sorted[idx];
    const prev = sorted[idx - 1];
    const next = sorted[idx + 1];

    const delta = snapToFrameSeconds(deltaSeconds, fps);
    const minDur = 1 / fps;

    let allowedDelta = delta;
    if (prev && allowedDelta < 0) {
        // Can't push into prev beyond its min duration
        const maxLeftShift = Math.max(0, prev.duration - minDur);
        allowedDelta = Math.max(-maxLeftShift, allowedDelta);
    }
    if (next && allowedDelta > 0) {
        // Can't push into next beyond its min duration
        const maxRightShift = Math.max(0, next.duration - minDur);
        allowedDelta = Math.min(maxRightShift, allowedDelta);
    }

    return sorted.map((el, i) => {
        if (i === idx) {
            return { ...el, startTime: Math.max(0, el.startTime + allowedDelta) };
        }
        if (i === idx - 1 && prev) {
            return { ...el, duration: Math.max(minDur, el.duration + allowedDelta) };
        }
        if (i === idx + 1 && next) {
            return {
                ...el,
                startTime: el.startTime + allowedDelta,
                duration: Math.max(minDur, el.duration - allowedDelta),
                trimStart: el.trimStart + allowedDelta
            };
        }
        return el;
    });
}

/**
 * Ripple deletes an element and shifts all subsequent elements to close the gap.
 */
export function rippleDeleteElement(
    elements: TimelineElement[],
    elementId: string,
    fps = 30
): TimelineElement[] {
    const target = elements.find(el => el.id === elementId);
    if (!target) return elements;

    const shiftAmount = target.duration;
    const deletedStart = target.startTime;

    return elements
        .filter(el => el.id !== elementId)
        .map(el => {
            if (el.startTime >= deletedStart) {
                return {
                    ...el,
                    startTime: Math.max(0, snapToFrameSeconds(el.startTime - shiftAmount, fps))
                };
            }
            return el;
        });
}

/**
 * Magnetic snap helper: snaps time to the nearest target (playhead, clip boundary, marker) within snap threshold.
 */
export function magneticSnap(
    time: number,
    snapTargets: number[],
    snapThresholdPx = 10,
    pxPerSecond = 50
): { snappedTime: number; didSnap: boolean; snapTarget?: number } {
    const thresholdSec = snapThresholdPx / Math.max(1, pxPerSecond);
    let closestTarget: number | undefined;
    let minDistance = Infinity;

    for (const target of snapTargets) {
        const dist = Math.abs(time - target);
        if (dist <= thresholdSec && dist < minDistance) {
            minDistance = dist;
            closestTarget = target;
        }
    }

    if (closestTarget !== undefined) {
        return { snappedTime: closestTarget, didSnap: true, snapTarget: closestTarget };
    }

    return { snappedTime: time, didSnap: false };
}

/**
 * Evaluates Cubic Bezier curve Y given normalized X in [0, 1].
 */
export function solveCubicBezierY(x1: number, y1: number, x2: number, y2: number, x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Newton-Raphson approximation for parameter t given x
    let t = x;
    for (let i = 0; i < 8; i++) {
        const currentX = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
        const dx = 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
        if (Math.abs(currentX - x) < 1e-5 || Math.abs(dx) < 1e-6) break;
        t -= (currentX - x) / dx;
        t = Math.max(0, Math.min(1, t));
    }

    // Evaluate y at t
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}

/**
 * Interpolates a numeric property value across keyframes at an offset time.
 */
export function getInterpolatedPropValue(
    keyframes: PropertyKeyframe[] | undefined,
    fallbackValue: number,
    offsetSeconds: number
): number {
    if (!keyframes || keyframes.length === 0) return fallbackValue;
    if (keyframes.length === 1) return keyframes[0].value;

    const sorted = [...keyframes].sort((a, b) => a.time - b.time);
    if (offsetSeconds <= sorted[0].time) return sorted[0].value;
    if (offsetSeconds >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;

    // Find bounding keyframes
    let k0 = sorted[0];
    let k1 = sorted[1];
    for (let i = 0; i < sorted.length - 1; i++) {
        if (offsetSeconds >= sorted[i].time && offsetSeconds <= sorted[i + 1].time) {
            k0 = sorted[i];
            k1 = sorted[i + 1];
            break;
        }
    }

    const span = k1.time - k0.time;
    if (span <= 0) return k0.value;
    const progress = (offsetSeconds - k0.time) / span;

    let tEased = progress;
    if (k0.easing === 'easeIn') {
        tEased = solveCubicBezierY(0.42, 0.0, 1.0, 1.0, progress);
    } else if (k0.easing === 'easeOut') {
        tEased = solveCubicBezierY(0.0, 0.0, 0.58, 1.0, progress);
    } else if (k0.easing === 'easeInOut') {
        tEased = solveCubicBezierY(0.42, 0.0, 0.58, 1.0, progress);
    } else if (k0.easing === 'cubicBezier' && k0.controlPoints) {
        const [x1, y1, x2, y2] = k0.controlPoints;
        tEased = solveCubicBezierY(x1, y1, x2, y2, progress);
    } else if (k0.easing === 'stepped') {
        tEased = progress >= 1 ? 1 : 0;
    }

    return k0.value + (k1.value - k0.value) * tEased;
}
