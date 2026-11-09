/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window check (user ask, 2026-11-07: "whenever the 3D building feature is loaded do a quick test like a CAPTCHA"):
 * a person is shown nine crops of facade photos from earlier pipeline K builds, each with one window-array site
 * outlined, and asked to select every image whose outlined box is a window. Their answers are the labels a learned site
 * decision is fitted on (in place of the array's hand-set contrast cut-offs), joined to the evidence the array recorded
 * for each site (window-array.ts ArrayRecord.evidence, SITE_EVIDENCE_FIELDS).
 *
 * The sites asked about are the ones the array was least sure of: added on dim evidence, withheld near the contradiction
 * line, or left outside the array where their own contrast reads like a window. Each check also holds one site the array
 * is sure is a window and one it is sure is wall, as a CAPTCHA does: a check that misses either keeps its answers marked
 * untrusted. Answers are appended to labels.jsonl in the label store (WINDOW_LABELS_DIR under the staged-location cache,
 * or SCRATCHBOX_WINDOW_LABELS_DIR); nothing is sent anywhere.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import { WINDOW_FIT_FILE, type WindowFitFile, type WindowRect } from '../window-fit';
import { SITE_DECISION, SITE_EVIDENCE_FIELDS, SITE_KIND, WINDOW_ARRAY_PARAMS, type ArrayRecord } from './window-array';

export const WINDOW_CHECK_VERSION = 'window-check/1';
/** The label store's directory under the staged-location cache. */
export const WINDOW_LABELS_DIR = 'window_labels';
export const WINDOW_LABELS_FILE = 'labels.jsonl';

export const WINDOW_CHECK_PARAMS = {
    /** Images per check (a 3 x 3 grid), of which one sure window and one sure wall. */
    tiles: 9,
    /** A crop shows the site and this many site sizes of facade around it on each side. */
    contextSites: 2,
    /** The crop's longer side (px). */
    tilePx: 200,
    /** Each crop's brightness is stretched between these percentiles for the eye (a dark facade reads); the labels are about what is there, not its tone. */
    stretch: [0.02, 0.98] as [number, number],
    /** A sure window: a box read and kept on its site with at least this confidence. */
    sureWindowConf: 0.8,
    /** A sure wall: a site outside the array whose contrast reads at most this (the opposite of a window, clearly). */
    sureWallContrast: -0.6,
    /** Sites under this share covered by the photo are never asked about (nothing to see). */
    minCovered: 0.8,
    /** Unanswered checks are forgotten after this long (ms). */
    ttlMs: 30 * 60 * 1000,
    /** Folders searched under each source root, at most this deep. */
    maxDepth: 6
} as const;

/** The label store: SCRATCHBOX_WINDOW_LABELS_DIR when set (an absolute folder), else WINDOW_LABELS_DIR under the cache. */
export function windowLabelsDir(cacheDir: string, env: NodeJS.ProcessEnv = process.env): string {
    const dir = env.SCRATCHBOX_WINDOW_LABELS_DIR?.trim();
    return dir && path.isAbsolute(dir) ? dir : path.join(cacheDir, WINDOW_LABELS_DIR);
}

/** The folders searched for earlier builds' facade photos: the cache's tile_refine, and SCRATCHBOX_WINDOW_CHECK_SOURCES (absolute folders, separated by the path delimiter or commas). */
export function windowCheckRoots(cacheDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
    const extra = (env.SCRATCHBOX_WINDOW_CHECK_SOURCES ?? '').split(new RegExp(`[,${path.delimiter === ';' ? ';' : ':'}]`)).map(s => s.trim()).filter(s => s && path.isAbsolute(s));
    return [path.join(cacheDir, 'tile_refine'), ...extra];
}

/** Every ortho folder (relief_orthos_k_*) under the roots whose window fit carries the array's site evidence. */
export function findWindowCheckSources(roots: string[], maxDepth: number = WINDOW_CHECK_PARAMS.maxDepth): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        if (path.basename(dir).startsWith('relief_orthos_k_')) {
            if (ents.some(e => e.isFile() && e.name === WINDOW_FIT_FILE) && hasEvidence(path.join(dir, WINDOW_FIT_FILE))) out.push(dir);
            return;
        }
        if (depth >= maxDepth) return;
        for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out.sort();
}

function hasEvidence(file: string): boolean {
    try {
        // a cheap look first: the key appears only when some facade recorded evidence
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size, chunk = Buffer.alloc(Math.min(size, 1 << 20));
            for (let pos = 0; pos < size; pos += chunk.length) {
                const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
                if (chunk.subarray(0, n).includes('"evidence":[')) return true;
            }
            return false;
        } finally { fs.closeSync(fd); }
    } catch { return false; }
}

/** One site a person may be asked about: where it is, what the array recorded, and why it was chosen. */
export interface CheckSite {
    source: string; facadeId: number; box: WindowRect;
    /** uncertain: the array was unsure; window / wall: the array is sure (the check's control images). */
    role: 'uncertain' | 'window' | 'wall';
    /** The array's evidence row (SITE_EVIDENCE_FIELDS), absent for a box read and kept. */
    evidence?: Array<number | null>;
    /** How close the array's decision came to its cut-off (0 at the cut-off, larger farther from it). */
    margin: number;
}

/**
 * The sites of one ortho folder, by role. Uncertain: a site added on contrast under the add bar (or unread), one withheld
 * within twice the contradiction line, or one left outside the array whose own contrast reaches the step bar; each with its
 * margin from the cut-off it was decided by. Sure windows: boxes kept on their sites with high confidence. Sure walls:
 * sites outside the array reading clearly the opposite of a window. Every site at least P.minCovered covered.
 */
export function checkSitesOf(source: string, P = WINDOW_CHECK_PARAMS, A = WINDOW_ARRAY_PARAMS): CheckSite[] {
    const fit = JSON.parse(fs.readFileSync(path.join(source, WINDOW_FIT_FILE), 'utf8')) as WindowFitFile;
    const out: CheckSite[] = [], nF = SITE_EVIDENCE_FIELDS.length;
    const F = Object.fromEntries(SITE_EVIDENCE_FIELDS.map((k, i) => [k, i])) as Record<(typeof SITE_EVIDENCE_FIELDS)[number], number>;
    for (const e of fit.facades) {
        if ('error' in e) continue;
        const a = (e as { array?: ArrayRecord }).array;
        if (!a?.evidence) continue;
        const ev = a.evidence;
        for (let q = 0; q + nF - 1 < ev.length; q += nF) {
            const row = ev.slice(q, q + nF), box = row.slice(0, 4) as WindowRect, dec = row[F.decision], c = row[F.contrast], cov = row[F.covered] ?? 0;
            if (cov < P.minCovered) continue;
            if (dec === SITE_DECISION.added) { if (c === null || c < A.addMinContrast) out.push({ source, facadeId: e.facadeId, box, role: 'uncertain', evidence: row, margin: c === null ? 0 : A.addMinContrast - c }); }
            else if (dec === SITE_DECISION.withheld) { if (c !== null && c >= 2 * A.contradict) out.push({ source, facadeId: e.facadeId, box, role: 'uncertain', evidence: row, margin: c - A.contradict }); }
            else if (dec === SITE_DECISION.outside && c !== null) {
                if (c >= A.stepContrast) out.push({ source, facadeId: e.facadeId, box, role: 'uncertain', evidence: row, margin: Math.abs(c - A.addMinContrast) });
                else if (c <= P.sureWallContrast) out.push({ source, facadeId: e.facadeId, box, role: 'wall', evidence: row, margin: P.sureWallContrast - c });
            }
        }
        for (let q = 0; q + 6 < a.sites.length; q += 7) if (a.sites[q + 4] === SITE_KIND.on && a.sites[q + 5] >= P.sureWindowConf) out.push({ source, facadeId: e.facadeId, box: a.sites.slice(q, q + 4) as WindowRect, role: 'window', margin: a.sites[q + 5] - P.sureWindowConf });
    }
    return out;
}

/** A site's key in the label store: its folder (by name from the cache root down), facade and box. */
export function siteKey(s: Pick<CheckSite, 'source' | 'facadeId' | 'box'>): string {
    return crypto.createHash('sha256').update(`${s.source}|${s.facadeId}|${s.box.join(',')}`).digest('hex').slice(0, 24);
}

/** The keys already answered (trusted or not), from the label store. */
export function answeredKeys(labelsDir: string): Set<string> {
    const file = path.join(labelsDir, WINDOW_LABELS_FILE), keys = new Set<string>();
    if (!fs.existsSync(file)) return keys;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { keys.add((JSON.parse(line) as { key: string }).key); } catch { /* a torn last line */ } }
    return keys;
}

/**
 * A crop of the facade photo around a site (P.contextSites site sizes of facade on each side), scaled so its longer side
 * is P.tilePx, its brightness stretched between the P.stretch percentiles, the site outlined in yellow, as a PNG. Texels
 * the photo never reached stay as the ortho draws them; past the facade's edge is a quiet neutral grey.
 */
export function cropSite(source: string, facadeId: number, box: WindowRect, P = WINDOW_CHECK_PARAMS): Buffer {
    const facades = (JSON.parse(fs.readFileSync(path.join(source, 'facades.json'), 'utf8')) as { facades: Array<{ facadeId: number; image: string }> }).facades;
    const f = facades.find(x => x.facadeId === facadeId);
    if (!f) throw new Error(`facade ${facadeId} is not in ${source}`);
    const img = decodePng(fs.readFileSync(path.join(source, f.image)));
    const bw = box[2] - box[0], bh = box[3] - box[1], side = Math.max(bw, bh) * (1 + 2 * P.contextSites);
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, x0 = cx - side / 2, y0 = cy - side / 2;
    const n = P.tilePx, s = side / n, rgba = new Uint8Array(n * n * 4), inside = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
        // the mean of the source texels under this output pixel (a box filter), mid-grey outside the photo
        const sx0 = x0 + u * s, sy0 = y0 + v * s; let r = 0, g = 0, b = 0, c = 0;
        for (let y = Math.floor(sy0); y < Math.ceil(sy0 + s); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx0 + s); x++) {
            if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
            const k = (y * img.width + x) * 4; r += img.rgba[k]; g += img.rgba[k + 1]; b += img.rgba[k + 2]; c++;
        }
        const o = (v * n + u) * 4;
        if (c) { rgba[o] = r / c; rgba[o + 1] = g / c; rgba[o + 2] = b / c; inside[v * n + u] = 1; }
        rgba[o + 3] = 255;
    }
    // the tones stretched for the eye: the crop's own low and high percentiles of brightness to black and white
    const lum = (o: number) => 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    // (over the photo only; past the facade's edge a quiet neutral, drawn after, so it never sets the tones)
    const ls: number[] = []; for (let k = 0; k < n * n; k++) if (inside[k]) ls.push(lum(k * 4));
    ls.sort((a, b) => a - b);
    const lo = ls.length ? ls[Math.floor(P.stretch[0] * (ls.length - 1))] : 0, hi = ls.length ? ls[Math.floor(P.stretch[1] * (ls.length - 1))] : 255;
    for (let k = 0; k < n * n; k++) {
        if (!inside[k]) { rgba.set([96, 96, 96], k * 4); continue; }
        if (hi - lo > 4) for (let c = 0; c < 3; c++) rgba[k * 4 + c] = Math.max(0, Math.min(255, Math.round((rgba[k * 4 + c] - lo) * 255 / (hi - lo))));
    }
    // the site outlined, two pixels wide, just outside its box
    const bx0 = Math.round((box[0] - x0) / s) - 2, by0 = Math.round((box[1] - y0) / s) - 2, bx1 = Math.round((box[2] - x0) / s) + 1, by1 = Math.round((box[3] - y0) / s) + 1;
    const dot = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < n && y < n) rgba.set([255, 214, 0, 255], (y * n + x) * 4); };
    for (let t = 0; t < 2; t++) { for (let x = bx0; x <= bx1; x++) { dot(x, by0 + t); dot(x, by1 - t); } for (let y = by0; y <= by1; y++) { dot(bx0 + t, y); dot(bx1 - t, y); } }
    return Buffer.from(encodePng(n, n, rgba, 4));
}

export interface WindowCheckTile { id: string; png: string }
export interface WindowCheck { id: string; version: string; prompt: string; detail: string; tiles: WindowCheckTile[] }
interface PendingCheck { id: string; at: number; sites: Array<CheckSite & { tileId: string; key: string }> }

/** Mulberry32: a small seeded generator, so a check can be drawn again in a test. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The checks handed out and their answers. `sources` are the ortho folders to draw from (findWindowCheckSources);
 * `labelsDir` the label store.
 */
export class WindowCheckService {
    private readonly pending = new Map<string, PendingCheck>();
    private readonly sitesBySource = new Map<string, CheckSite[]>();
    constructor(private readonly sources: () => string[], private readonly labelsDir: string, private readonly P = WINDOW_CHECK_PARAMS, private readonly now: () => number = Date.now) {}

    private sitesOf(source: string): CheckSite[] {
        let s = this.sitesBySource.get(source);
        if (!s) { s = checkSitesOf(source, this.P); this.sitesBySource.set(source, s); }
        return s;
    }

    /**
     * A new check: P.tiles - 2 uncertain sites not yet answered (the nearest their cut-off first, from one folder at a
     * time so the crops are read from few photos), one sure window and one sure wall, in a shuffled grid; undefined with
     * the reason when no folder has enough.
     */
    next(seed: number = Math.floor(Math.random() * 2 ** 31)): { check?: WindowCheck; reason?: string } {
        const t = this.now();
        for (const [id, p] of this.pending) if (t - p.at > this.P.ttlMs) this.pending.delete(id);
        const sources = this.sources();
        if (!sources.length) return { reason: 'no earlier pipeline K build with window-array evidence was found on this machine' };
        const done = answeredKeys(this.labelsDir), r = rng(seed);
        const order = sources.map(s => ({ s, k: r() })).sort((a, b) => a.k - b.k).map(x => x.s);
        for (const source of order) {
            const all = this.sitesOf(source).filter(s => !done.has(siteKey(s)));
            const unsure = all.filter(s => s.role === 'uncertain').sort((a, b) => a.margin - b.margin);
            const win = all.filter(s => s.role === 'window'), wall = all.filter(s => s.role === 'wall');
            const need = this.P.tiles - 2;
            if (unsure.length < need || !win.length || !wall.length) continue;
            // the nearest the cut-off, drawn from the closest quarter so successive checks do not show one facade only
            const pool = unsure.slice(0, Math.max(need, Math.ceil(unsure.length / 4)));
            const picked: CheckSite[] = [];
            while (picked.length < need && pool.length) picked.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
            picked.push(win[Math.floor(r() * win.length)], wall[Math.floor(r() * wall.length)]);
            const grid = picked.map(s => ({ s, k: r() })).sort((a, b) => a.k - b.k).map(x => x.s);
            const id = crypto.randomBytes(8).toString('hex');
            const sites = grid.map((s, i) => ({ ...s, tileId: `${id}-${i}`, key: siteKey(s) }));
            const tiles = sites.map(s => ({ id: s.tileId, png: cropSite(s.source, s.facadeId, s.box, this.P).toString('base64') }));
            this.pending.set(id, { id, at: t, sites });
            return { check: { id, version: WINDOW_CHECK_VERSION, prompt: 'windows', detail: 'Select every image where the yellow box is on a window.', tiles } };
        }
        return { reason: `no earlier build has ${this.P.tiles - 2} unanswered uncertain sites with a sure window and a sure wall beside them` };
    }

    /** A check's images by id with the role of each (uncertain, or the sure window and wall), for review tools; undefined once answered or expired. */
    inspect(checkId: string): Array<{ tileId: string; role: CheckSite['role']; facadeId: number; box: WindowRect }> | undefined {
        return this.pending.get(checkId)?.sites.map(s => ({ tileId: s.tileId, role: s.role, facadeId: s.facadeId, box: s.box }));
    }

    /**
     * The answer to a check: `selected` the tile ids marked as windows. Every uncertain site is stored with its label and
     * evidence, trusted when both control images were answered right; a skipped check stores nothing.
     */
    answer(checkId: string, selected: string[], skipped = false): { stored: number; controlsPassed: boolean } {
        const p = this.pending.get(checkId);
        if (!p) throw new Error('this window check is not known (it expired or was answered)');
        this.pending.delete(checkId);
        const sel = new Set(selected);
        const controlsPassed = p.sites.every(s => s.role === 'uncertain' || (s.role === 'window') === sel.has(s.tileId));
        if (skipped) return { stored: 0, controlsPassed: false };
        fs.mkdirSync(this.labelsDir, { recursive: true });
        const at = new Date(this.now()).toISOString();
        const lines = p.sites.filter(s => s.role === 'uncertain').map(s => JSON.stringify({
            version: WINDOW_CHECK_VERSION, key: s.key, at, check: p.id, source: s.source, facadeId: s.facadeId, box: s.box,
            window: sel.has(s.tileId), trusted: controlsPassed, evidence: s.evidence, fields: SITE_EVIDENCE_FIELDS
        }));
        fs.appendFileSync(path.join(this.labelsDir, WINDOW_LABELS_FILE), lines.map(l => l + '\n').join(''));
        return { stored: lines.length, controlsPassed };
    }
}
