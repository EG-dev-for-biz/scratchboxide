/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Helpers for source-string assertions over the decomposed Studio + Settings surfaces.
 *
 * `GenerativeCanvasStudio.tsx` and `SettingsModal.tsx` used to be monoliths; their UI and
 * logic now live across several folders. Tests that grep for labels, class names, handlers,
 * etc. should read the whole surface rather than a single file.
 */
import * as fs from 'fs';
import * as path from 'path';

export const GENERATIVE_CANVAS_DIR = path.resolve(__dirname, '../src/browser/generative-canvas');

export const STUDIO_ENTRY = path.join(GENERATIVE_CANVAS_DIR, 'GenerativeCanvasStudio.tsx');
export const SETTINGS_ENTRY = path.join(GENERATIVE_CANVAS_DIR, 'SettingsModal.tsx');

/** Folders that (together with the entry file) make up the Studio surface. */
export const STUDIO_SOURCE_DIRS = ['studio', 'chat', 'state', 'hooks'];
/** Folders that (together with the entry file) make up the Settings surface. */
export const SETTINGS_SOURCE_DIRS = ['settings'];

function listSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listSourceFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out.sort();
}

function collect(entry: string, dirs: string[]): string[] {
    const files = [entry];
    for (const dir of dirs) {
        files.push(...listSourceFiles(path.join(GENERATIVE_CANVAS_DIR, dir)));
    }
    return files;
}

function readAll(files: string[]): string {
    return files
        .filter(f => fs.existsSync(f))
        .map(f => `// ---- ${path.relative(GENERATIVE_CANVAS_DIR, f)}\n${fs.readFileSync(f, 'utf-8')}`)
        .join('\n');
}

/** Absolute paths of every file that makes up the Studio surface. */
export function listStudioSourceFiles(): string[] {
    return collect(STUDIO_ENTRY, STUDIO_SOURCE_DIRS);
}

/** Absolute paths of every file that makes up the Settings surface. */
export function listSettingsSourceFiles(): string[] {
    return collect(SETTINGS_ENTRY, SETTINGS_SOURCE_DIRS);
}

/** Concatenated source of `GenerativeCanvasStudio.tsx` + `studio/`, `chat/`, `state/`, `hooks/`. */
export function readStudioSources(): string {
    return readAll(listStudioSourceFiles());
}

/** Concatenated source of `SettingsModal.tsx` + `settings/**`. */
export function readSettingsSources(): string {
    return readAll(listSettingsSourceFiles());
}
