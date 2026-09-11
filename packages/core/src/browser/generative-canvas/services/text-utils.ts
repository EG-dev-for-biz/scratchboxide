/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Lower-cases text and collapses every non-alphanumeric run into a single hyphen.
 * Falls back to `'item'` when nothing survives so callers always get a usable id fragment.
 */
export function slugify(text: string): string {
    return (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '') || 'item';
}
