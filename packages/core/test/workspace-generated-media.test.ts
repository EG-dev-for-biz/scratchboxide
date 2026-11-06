/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The workspace tools and the app's own generated pictures (2026-11-06 app test): generate_image and
 * vfx_segment_subject write under build/generated-images, inside the protected build/ folder, so workspace_view_image
 * refused every picture, mask and matte they made, and a refused command left the model guessing. The pictures are
 * now readable (never writable), and a refusal names the next step.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxCommandRejectedError } from '../src/node/security/sandbox-policy';
import { GENERATED_IMAGES_DIR, resolveRepoRoot } from '../src/node/gemini/tools/nano-banana-tools';
import { assertSafeWorkspacePath, generatedImagePath, sandboxRefusalNextStep, workspaceHandlers } from '../src/node/gemini/tools/workspace-tools';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636060606000000005000173b0a4b40000000049454e44ae426082', 'hex');

describe('the app\'s generated pictures', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-repo-'));
    const dir = path.join(repo, GENERATED_IMAGES_DIR);
    fs.mkdirSync(path.join(dir, 'car_cutout'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'car_cutout', 'matte_0000.png'), PNG);

    it('a path in generated-images resolves there, as a tool result writes it: relative, absolute or the app URL', () => {
        const want = fs.realpathSync(path.join(dir, 'car_cutout', 'matte_0000.png'));
        expect(generatedImagePath('build/generated-images/car_cutout/matte_0000.png', repo)).toBe(want);
        expect(generatedImagePath('./build/generated-images/car_cutout/matte_0000.png', repo)).toBe(want);
        expect(generatedImagePath(path.join(dir, 'car_cutout', 'matte_0000.png'), repo)).toBe(want);
        expect(generatedImagePath('/build/generated-images/car_cutout/matte_0000.png', repo)).toBe(want);
    });

    it('nothing outside it does: other build folders, escapes, the folder itself', () => {
        expect(generatedImagePath('build/run/x.png', repo)).toBeUndefined();
        expect(generatedImagePath('build/generated-images/../run/x.png', repo)).toBeUndefined();
        expect(generatedImagePath('/build/generated-images/../../etc/passwd', repo)).toBeUndefined();
        expect(generatedImagePath('build/generated-images', repo)).toBeUndefined();
        expect(generatedImagePath('plates/wall.png', repo)).toBeUndefined();
        expect(generatedImagePath('', repo)).toBeUndefined();
    });

    it('the path guard lets the agent read and view them, and still refuses writes and the rest of build/', () => {
        expect(() => assertSafeWorkspacePath('build/generated-images/car_cutout/matte_0000.png', 'view')).not.toThrow();
        expect(() => assertSafeWorkspacePath('build/generated-images/car_cutout/matte_0000.png', 'read')).not.toThrow();
        expect(() => assertSafeWorkspacePath('build/generated-images/car_cutout/matte_0000.png', 'write')).toThrow(/Access denied/);
        expect(() => assertSafeWorkspacePath('build/generated-images/x.png', 'diff edit')).toThrow(/Access denied/);
        expect(() => assertSafeWorkspacePath('build/run/x.png', 'view')).toThrow(/Access denied/);
        expect(() => assertSafeWorkspacePath('node_modules/x/index.js', 'read')).toThrow(/Access denied/);
    });
});

describe('workspace_view_image on a generated picture', () => {
    // the handler reads the real repository's generated-images folder; this test's file is removed afterwards
    const dir = path.join(resolveRepoRoot(), GENERATED_IMAGES_DIR, `__test_view_${process.pid}`);
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('shows it while the chat has another folder open', async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'mask_0000.png'), PNG);
        const openWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-open-'));
        const rel = `${GENERATED_IMAGES_DIR}/${path.basename(dir)}/mask_0000.png`;
        const out = await workspaceHandlers.workspace_view_image({ filePath: rel, label: 'mask' }, { workspaceRoot: openWorkspace } as never);
        const shown = out.resultPayload.modelImages as Array<{ path: string; mimeType: string }>;
        expect(shown).toHaveLength(1);
        expect(shown[0].mimeType).toBe('image/png');
        expect(fs.realpathSync(shown[0].path)).toBe(fs.realpathSync(path.join(dir, 'mask_0000.png')));
    });
});

describe('a refused command names the next step', () => {
    it('by the refusal\'s reason', () => {
        expect(sandboxRefusalNextStep('inline_code')).toMatch(/script file with workspace_write_file/);
        expect(sandboxRefusalNextStep('not_allowlisted')).toMatch(/dedicated tool/);
        expect(sandboxRefusalNextStep('redirect')).toBe('');
        expect(sandboxRefusalNextStep(undefined)).toBe('');
    });

    it('workspace_run_command adds it to the sandbox\'s own message', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-run-'));
        const sandbox = {
            createEnvironment: async () => undefined,
            executeCommand: async () => {
                throw new SandboxCommandRejectedError('Blocked by sandbox policy: command "ffmpeg" is not in the allowlist (segment: "ffmpeg -i a.png b.png")', 'ffmpeg -i a.png b.png', 'not_allowlisted');
            }
        };
        const ctx = { workspaceRoot: root, sandbox, request: { mode: 'agent' } } as never;
        await expect(Promise.resolve(workspaceHandlers.workspace_run_command({ command: 'ffmpeg -i a.png b.png' }, ctx)))
            .rejects.toThrow(/not in the allowlist.*use a dedicated tool instead/);
    });
});
