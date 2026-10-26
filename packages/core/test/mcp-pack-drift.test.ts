/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The stdio MCP serves every tool pack the in-app chat registers, except the packs that need the IDE. Fails when
 * tool-registry.ts imports a declarations constant that standalone-packs.ts neither serves nor names as IDE-only, when
 * a served pack lists a tool with no handler, and when the MCP entry point .mcp.json runs does not take its tools from
 * the shared list.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { IDE_ONLY_PACKS, mergeStandalonePacks, STANDALONE_PACKS } from '../src/node/mcp/standalone-packs';

const SRC = path.join(__dirname, '..', 'src', 'node');

describe('MCP tool packs', () => {
    it('serves every pack tool-registry.ts registers, except the IDE-only ones', () => {
        const registry = fs.readFileSync(path.join(SRC, 'gemini', 'tool-registry.ts'), 'utf8');
        const registered = [...new Set(registry.match(/\b[A-Z0-9_]+_TOOL_DECLARATIONS\b/g) ?? [])];
        expect(registered.length).toBeGreaterThan(30);
        const served = new Set(STANDALONE_PACKS.map(p => p.name));
        // DEFAULT_TOOL_DECLARATIONS is the registry's own union of packs, not a pack
        const missing = registered.filter(n => !served.has(n) && !IDE_ONLY_PACKS.includes(n) && n !== 'DEFAULT_TOOL_DECLARATIONS');
        expect(missing, `packs the chat registers that the MCP neither serves nor names IDE-only: ${missing.join(', ')}`).toEqual([]);
        const extra = STANDALONE_PACKS.filter(p => !registered.includes(p.name)).map(p => p.name);
        expect(extra, `packs the MCP serves that the chat no longer registers: ${extra.join(', ')}`).toEqual([]);
    });

    it('lists only tools it can call, and far more than the VFX pack alone', () => {
        const { declarations, handlers, unhandled } = mergeStandalonePacks();
        expect(unhandled, `declared tools with no handler: ${unhandled.join(', ')}`).toEqual([]);
        expect(declarations.length).toBe(Object.keys(handlers).length);
        for (const name of ['google_3d_tiles_get_clay', 'build_3d_object_from_reference', 'vfx_segment_subject', 'workspace_view_file', 'sb_roadie']) {
            expect(handlers[name], name).toBeTypeOf('function');
        }
        expect(declarations.length).toBeGreaterThan(150);
    });

    it('both stdio entry points take their tools from the shared list', () => {
        for (const entry of ['scratchbox-mcp.ts', 'scratchbox-mcp-server.ts']) {
            const src = fs.readFileSync(path.join(SRC, 'mcp', entry), 'utf8');
            expect(src, entry).toMatch(/from '\.\/standalone-packs'/);
            expect(src, entry).not.toMatch(/const STANDALONE_PACKS\s*[:=]/);
        }
    });
});
