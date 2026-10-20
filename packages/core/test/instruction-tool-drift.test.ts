/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Instructions must not name tools that do not exist. AGENTS.md, the in-app system prompt, the capability resolver and
 * every skill are read for tool-like names in backticks (`snake_case`, optionally followed by a call), and each one
 * whose first word is the first word of a real tool or viewport operator must be a registered Gemini tool or a
 * viewport operator. A name that only looks like a tool (a parameter, a file stem) is listed in NOT_TOOLS with why.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

const REPO = path.resolve(__dirname, '../../..');

/** Names in backticks that share a tool's first word but are not tools (each with the reason). */
const NOT_TOOLS: Record<string, string> = {
    google_maps_platform: 'the deactivated generic plugin skill AGENTS.md says never to load',
    mesh_reshape_via_prompt: 'named in native-mesh-reshaping only to say it does not exist',
    pbr_texture_batch: 'a native command-line program (scripts/pbr_texture_batch.cpp), not a chat tool',
    video_blockout: 'an export format value of universal_3d_structure, not a tool',
    generate_content: 'a Google GenAI SDK method (coding-agent skill)',
    generate_videos: 'a Google GenAI SDK method (coding-agent skill)',
    read_page: "a Claude Code browser-pane tool (coding-agent skill)",
    read_console_messages: "a Claude Code browser-pane tool (coding-agent skill)",
    read_network_requests: "a Claude Code browser-pane tool (coding-agent skill)",
};

/**
 * Tools that instructions name but nothing registers yet, to fix (replace the name with the real tool, or build it).
 * Listed so new drift fails at once; an entry that no longer drifts fails too, so the list stays exact.
 */
const KNOWN_DRIFT: Record<string, string[]> = {
    '.agents/skills/geo-camera-matchmove-pipeline/SKILL.md': ['adaptive_matchmove_render_blockout'],
};

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.md')) out.push(p);
    }
    return out;
}

/** Viewport operators (`sb_*` and the like), declared as `name: '...'` in the operator packs. */
function operatorNames(): Set<string> {
    const dir = path.join(REPO, 'packages/core/src/browser/generative-canvas/services/operators');
    const names = new Set<string>();
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.ts')) continue;
        for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) names.add(m[1]);
    }
    return names;
}

/** Tool-like names in backticks: `a_b`, `a_b_c(...)`, `a_b({ ... })`. */
function backtickedNames(text: string): string[] {
    const out = new Set<string>();
    for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=[`(\s])/g)) out.add(m[1]);
    return [...out];
}

describe('instructions name only tools that exist', () => {
    const registry = createDefaultToolRegistry();
    const operators = operatorNames();
    const toolNames = registry.declarations().map(d => d.name);
    const exists = (n: string) => registry.has(n) || operators.has(n);
    const prefixes = new Set([...toolNames, ...operators].map(n => n.split('_')[0]));

    const sources = [
        'AGENTS.md',
        'packages/core/src/node/gemini/prompt-builder.ts',
        'packages/core/src/node/agent/task-capability-resolver.ts',
        ...walk(path.join(REPO, '.agents/skills')).map(p => path.relative(REPO, p)),
        ...walk(path.join(REPO, '.claude/skills')).map(p => path.relative(REPO, p)),
    ];

    it('finds the registry and the sources', () => {
        expect(toolNames.length).toBeGreaterThan(50);
        expect(operators.size).toBeGreaterThan(10);
        expect(sources.length).toBeGreaterThan(10);
    });

    for (const rel of sources) {
        it(`${rel} names only real tools`, () => {
            const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
            const missing = backtickedNames(text).filter(n => prefixes.has(n.split('_')[0]) && !exists(n) && !(n in NOT_TOOLS));
            expect(missing.sort(), `${rel} names tools that are not registered: ${missing.join(', ')}`).toEqual([...(KNOWN_DRIFT[rel] ?? [])].sort());
        });
    }
});
