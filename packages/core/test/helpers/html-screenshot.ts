/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { REPO_ROOT, type Requirement } from './requirements';

const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
];

const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));

/** Whether headless Chrome is installed, for `it.skipIf(!htmlScreenshotChrome.ok)`. */
export const htmlScreenshotChrome: Requirement = chromePath
    ? { ok: true, reason: '' }
    : { ok: false, reason: `headless Chrome not found (looked in ${CHROME_CANDIDATES.join(', ')}); install Google Chrome or Chromium` };

const SHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots');

/**
 * Renders `bodyHtml` (e.g. renderToStaticMarkup of a component) in headless Chrome and saves the PNG to
 * test-results/screenshots/<name>.png (gitignored). Returns the PNG path and bytes.
 */
export async function saveHtmlScreenshot(
    name: string,
    bodyHtml: string,
    options: { width?: number; height?: number; background?: string } = {}
): Promise<{ path: string; png: Buffer }> {
    if (!chromePath) throw new Error(htmlScreenshotChrome.reason);
    const width = options.width ?? 800;
    const height = options.height ?? 450;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-html-shot-'));
    const htmlPath = path.join(work, 'page.html');
    const shotPath = path.join(work, 'shot.png');
    fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; width: ${width}px; height: ${height}px; background: ${options.background ?? '#b0b8c4'};
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #e4e4e7; }
        body > div.root { position: relative; width: 100%; height: 100%; overflow: hidden; }
    </style></head><body><div class="root">${bodyHtml}</div></body></html>`);

    await new Promise<void>(resolve => {
        const proc = spawn(chromePath, [
            '--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-gpu',
            // A bare HOME (as in credential-free test runs) leaves Chrome waiting on the macOS keychain; the page is a
            // local file, so no keychain, sync or background network is needed.
            '--use-mock-keychain', '--password-store=basic', '--no-default-browser-check',
            '--disable-background-networking', '--disable-component-update', '--disable-sync',
            // greyscale text antialiasing on every host: Linux renders subpixel (LCD) text by default, whose coloured fringes
            // read as saturated pixels that are not in the page (macOS has drawn no LCD text since 10.14)
            '--disable-lcd-text',
            `--window-size=${width},${height}`,
            `--user-data-dir=${path.join(work, 'profile')}`,
            `--screenshot=${shotPath}`,
            `file://${htmlPath}`
        ], { stdio: 'ignore' });
        const finish = () => {
            clearInterval(poll);
            clearTimeout(deadline);
            if (proc.exitCode === null) proc.kill('SIGKILL');
            resolve();
        };
        // Recent Chrome builds write the screenshot but keep running; stop once the PNG is complete (IEND chunk).
        const poll = setInterval(() => {
            if (!fs.existsSync(shotPath)) return;
            const buf = fs.readFileSync(shotPath);
            if (buf.length > 12 && buf.subarray(buf.length - 8, buf.length - 4).toString('latin1') === 'IEND') finish();
        }, 300);
        const deadline = setTimeout(finish, 60_000);
        proc.on('close', finish);
        proc.on('error', finish);
    });

    if (!fs.existsSync(shotPath)) throw new Error(`headless Chrome wrote no screenshot for ${name}`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const out = path.join(SHOT_DIR, `${name.replace(/[^a-zA-Z0-9_-]+/g, '_')}.png`);
    fs.copyFileSync(shotPath, out);
    try {
        // Chrome can still be flushing its profile directory right after it is stopped.
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // A leftover temp directory is harmless; the screenshot is already saved.
    }
    return { path: out, png: fs.readFileSync(out) };
}
