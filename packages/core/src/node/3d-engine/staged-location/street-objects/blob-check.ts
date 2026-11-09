/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The blob check (user ask, 2026-11-08, after the window check: "we could potentially train a regressor to identify blobs
 * as well this way"): a person is shown nine top-down tile patches of a district's blobs, each blob outlined in magenta,
 * and asked to select every image where the box is on a given thing. The thing is a word from the vision model's own
 * labels of those blobs (blob-reader.ts: open vocabulary, never a list of ours), or, for the scan-fault answer, "nothing
 * but ground, wall or roof". The answers are labels joined to each blob's measures (BLOB_EVIDENCE_FIELDS), the rows a
 * learned blob decision can be fitted on, and an honest accuracy figure for the model's labels in the meantime.
 *
 * The blobs asked about are the ones the model was least sure of; each check also holds one blob the model is sure is
 * the thing and one it is sure is something else, as a CAPTCHA does: a check that misses either keeps its answers marked
 * untrusted. Answers are appended to labels.jsonl in the blob label store (BLOB_LABELS_DIR under the staged-location
 * cache, or SCRATCHBOX_BLOB_LABELS_DIR); nothing is sent anywhere. The words pick which blobs share a question; no
 * geometry or build step reads them.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BlobEvidence, BlobLabel } from './blob-reader';

export const BLOB_CHECK_VERSION = 'blob-check/1';
export const BLOB_LABELS_DIR = 'blob_labels';
export const BLOB_LABELS_FILE = 'labels.jsonl';
/** What a blob read leaves for the check beside its report: the report, and each read blob's patch as `<clusterId>.jpg`. */
export const BLOB_READ_FILE = 'blob_read.json';
export const BLOB_PATCHES_DIR = 'blob_patches';

export const BLOB_CHECK_PARAMS = {
    tiles: 9,
    /** A control: the model's label at least this sure. */
    sureConf: 0.85,
    /** A subject word needs this many blobs carrying it (and one sure control). */
    minPerSubject: 4,
    /** Of the uncertain tiles, at most this many carry the subject word (the rest are other blobs, so "none" is a real answer). */
    maxSubjectTiles: 5,
    /** With a place given, only reads whose origin is within this of it are asked from (m). */
    nearM: 600,
    ttlMs: 30 * 60 * 1000,
    maxDepth: 4
} as const;

/** The measures stored with each answer, in order (BlobEvidence's numbers, flattened). */
export const BLOB_EVIDENCE_FIELDS = ['heightM', 'standM', 'planLongM', 'planShortM', 'areaM2', 'triangles', 'verticality', 'thinness', 'elongation', 'radialSymmetry', 'radiusMedianM', 'periodM', 'upShare', 'sideShare', 'groundedShare', 'toBuildingM', 'toRoadM', 'onCarriageway'] as const;

export function evidenceRow(e: BlobEvidence): Array<number | null> {
    return [e.heightM, e.standM, e.planM[0], e.planM[1], e.areaM2, e.triangles, e.verticality, e.thinness, e.elongation, e.radialSymmetry, e.radiusMedianM, e.periodM, e.upShare, e.sideShare, e.groundedShare, e.vector.toBuildingM, e.vector.toRoadM, e.vector.onCarriageway ? 1 : 0];
}

export function blobLabelsDir(cacheDir: string, env: NodeJS.ProcessEnv = process.env): string {
    const dir = env.SCRATCHBOX_BLOB_LABELS_DIR?.trim();
    return dir && path.isAbsolute(dir) ? dir : path.join(cacheDir, BLOB_LABELS_DIR);
}

/** Every folder under the roots holding a blob read and its patches. */
export function findBlobCheckSources(roots: string[], maxDepth: number = BLOB_CHECK_PARAMS.maxDepth): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        if (ents.some(e => e.isFile() && e.name === BLOB_READ_FILE) && ents.some(e => e.isDirectory() && e.name === BLOB_PATCHES_DIR)) { out.push(dir); return; }
        if (depth >= maxDepth) return;
        for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== BLOB_PATCHES_DIR) walk(path.join(dir, e.name), depth + 1);
    };
    for (const r of roots) walk(r, 0);
    return out.sort();
}

const STOP = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'with', 'on', 'in', 'at', 'by', 'to', 'from', 'two', 'three', 'row', 'small', 'large', 'possible', 'probably', 'likely', 'some', 'its', 'part', 'side', 'edge', 'top', 'together']);

/** A label's content words, lower case, a plural's trailing s dropped (labels only: they group blobs into questions). */
export function labelWords(label: string): string[] {
    return [...new Set((label.toLowerCase().match(/[a-z]+/g) ?? []).filter(w => w.length > 2 && !STOP.has(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)))];
}

/**
 * The word a check asks about for a label: its last content word (in an English label that is the thing itself: "parked
 * car" -> car, "traffic cone" -> cone; the words before it say what kind), before any "with", "on", "and" or the like,
 * passing a trailing participle ("cars merged" -> car). Of a label naming two things ("van or truck"), the first's.
 * Labels only.
 */
export function headWord(label: string): string | undefined {
    const first = label.toLowerCase().split(/\b(?:or|with|on|in|under|beside|near|and|at)\b|,|\/|\(/)[0];
    const w = labelWords(first);
    // a trailing participle ("cars merged", "post leaning") says what happened to the thing, not what it is
    for (let i = w.length - 1; i >= 0; i--) if (!/(ed|ing)$/.test(w[i])) return w[i];
    return w[w.length - 1];
}

interface Source { dir: string; origin?: { lat: number; lng: number }; evidence: Map<number, BlobEvidence>; labels: BlobLabel[] }

export interface CheckBlob { source: string; clusterId: number; role: 'uncertain' | 'yes' | 'no'; label: BlobLabel; evidence: BlobEvidence }
export interface BlobCheckTile { id: string; jpg: string }
export interface BlobCheck { id: string; version: string; lead: string; subject: string; note: string; detail: string; tiles: BlobCheckTile[] }
interface Pending { id: string; at: number; subject: string; kind: 'word' | 'nothing'; blobs: Array<CheckBlob & { tileId: string; key: string }> }

export function blobKey(source: string, clusterId: number): string {
    return crypto.createHash('sha256').update(`${path.basename(source)}|${clusterId}`).digest('hex').slice(0, 24);
}

export function answeredBlobKeys(labelsDir: string): Set<string> {
    const file = path.join(labelsDir, BLOB_LABELS_FILE), keys = new Set<string>();
    if (!fs.existsSync(file)) return keys;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { keys.add((JSON.parse(line) as { key: string }).key); } catch { /* a torn last line */ } }
    return keys;
}

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const haversineM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const R = 6371000, d = Math.PI / 180, x = Math.sin(((b.lat - a.lat) * d) / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(((b.lng - a.lng) * d) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
};

/**
 * The checks handed out and their answers. `sources` are the blob read folders (findBlobCheckSources); `labelsDir` the
 * blob label store.
 */
export class BlobCheckService {
    private readonly pending = new Map<string, Pending>();
    private readonly loaded = new Map<string, Source>();
    constructor(private readonly sources: () => string[], private readonly labelsDir: string, private readonly P = BLOB_CHECK_PARAMS, private readonly now: () => number = Date.now) {}

    private load(dir: string): Source {
        let s = this.loaded.get(dir);
        if (!s) {
            const j = JSON.parse(fs.readFileSync(path.join(dir, BLOB_READ_FILE), 'utf8')) as { evidence: BlobEvidence[]; labels: BlobLabel[]; origin?: { lat: number; lng: number } };
            const patches = new Set(fs.readdirSync(path.join(dir, BLOB_PATCHES_DIR)));
            s = { dir, ...(j.origin ? { origin: j.origin } : {}), evidence: new Map(j.evidence.map(e => [e.clusterId, e])), labels: j.labels.filter(l => patches.has(`${l.clusterId}.jpg`)) };
            this.loaded.set(dir, s);
        }
        return s;
    }

    /**
     * A new check from one read (with `near`, only reads within P.nearM of it): a subject (a word of the model's confident labels that
     * enough blobs carry, or the scan-fault question), up to P.maxSubjectTiles uncertain blobs whose label carries it,
     * other uncertain blobs to fill P.tiles - 2, one sure yes and one sure no, shuffled; undefined with the reason when no
     * read has enough left to ask.
     */
    next(seed: number = Math.floor(Math.random() * 2 ** 31), near?: { lat: number; lng: number }): { check?: BlobCheck; reason?: string } {
        const t = this.now();
        for (const [id, p] of this.pending) if (t - p.at > this.P.ttlMs) this.pending.delete(id);
        const dirs = this.sources();
        if (!dirs.length) return { reason: 'no blob read (location_street_objects) was found on this machine' };
        const r = rng(seed), done = answeredBlobKeys(this.labelsDir);
        // with a place, only the reads near it (a building elsewhere gets its window check instead)
        const srcs = dirs.map(d => this.load(d)).map(s => ({ s, d: near && s.origin ? haversineM(near, s.origin) : Infinity, k: r() }))
            .filter(x => !near || x.d <= this.P.nearM).sort((a, b) => a.k - b.k).map(x => x.s);
        if (!srcs.length) return { reason: `no blob read within ${this.P.nearM} m of this place` };
        for (const s of srcs) {
            const open = s.labels.filter(l => !done.has(blobKey(s.dir, l.clusterId)) && s.evidence.has(l.clusterId));
            // the subjects: the scan-fault question, and each word the model's confident non-fault labels share often enough
            const counts = new Map<string, number>();
            for (const l of s.labels) if (l.confidence >= 0.6 && l.scanFault < 0.5) { const w = headWord(l.label); if (w) counts.set(w, (counts.get(w) ?? 0) + 1); }
            const words = [...counts].filter(([, n]) => n >= this.P.minPerSubject).map(([w]) => w);
            const subjects: Array<{ kind: 'word' | 'nothing'; subject: string; has: (l: BlobLabel) => boolean }> = [
                ...words.map(w => ({ kind: 'word' as const, subject: w, has: (l: BlobLabel) => headWord(l.label) === w })),
                { kind: 'nothing' as const, subject: 'nothing but ground, wall or roof', has: (l: BlobLabel) => l.scanFault >= 0.5 }
            ].map(x => ({ x, k: r() })).sort((a, b) => a.k - b.k).map(x => x.x);
            for (const sub of subjects) {
                const yes = s.labels.filter(l => sub.has(l) && l.confidence >= this.P.sureConf && (sub.kind === 'nothing' || l.scanFault < 0.5));
                const no = s.labels.filter(l => !sub.has(l) && l.confidence >= this.P.sureConf && (sub.kind === 'word' || l.scanFault < 0.2));
                const unsureWith = open.filter(l => sub.has(l)).sort((a, b) => a.confidence - b.confidence);
                const unsureOther = open.filter(l => !sub.has(l)).sort((a, b) => a.confidence - b.confidence);
                const need = this.P.tiles - 2;
                if (!yes.length || !no.length || unsureWith.length < 2 || unsureWith.length + unsureOther.length < need) continue;
                const pickFrom = (pool: BlobLabel[], n: number) => { const p = pool.slice(0, Math.max(n, Math.ceil(pool.length / 3))), out: BlobLabel[] = []; while (out.length < n && p.length) out.push(p.splice(Math.floor(r() * p.length), 1)[0]); return out; };
                const w = pickFrom(unsureWith, Math.min(this.P.maxSubjectTiles, need - 1));
                const o = pickFrom(unsureOther, need - w.length);
                if (w.length + o.length < need) continue;
                const as = (l: BlobLabel, role: CheckBlob['role']): CheckBlob => ({ source: s.dir, clusterId: l.clusterId, role, label: l, evidence: s.evidence.get(l.clusterId)! });
                const yesPool = yes.filter(l => !w.includes(l)), noPool = no.filter(l => !o.includes(l));
                if (!yesPool.length || !noPool.length) continue;
                const ctrlYes = yesPool[Math.floor(r() * yesPool.length)], ctrlNo = noPool[Math.floor(r() * noPool.length)];
                const picked = [...w.map(l => as(l, 'uncertain')), ...o.map(l => as(l, 'uncertain')), as(ctrlYes, 'yes'), as(ctrlNo, 'no')];
                const grid = picked.map(b => ({ b, k: r() })).sort((a, b) => a.k - b.k).map(x => x.b);
                const id = crypto.randomBytes(8).toString('hex');
                const blobs = grid.map((b, i) => ({ ...b, tileId: `${id}-${i}`, key: blobKey(b.source, b.clusterId) }));
                const tiles = blobs.map(b => ({ id: b.tileId, jpg: fs.readFileSync(path.join(b.source, BLOB_PATCHES_DIR, `${b.clusterId}.jpg`)).toString('base64') }));
                this.pending.set(id, { id, at: t, subject: sub.subject, kind: sub.kind, blobs });
                const lead = sub.kind === 'nothing' ? 'Select every image where the magenta box holds' : `Select every image where the magenta box is on a`;
                return {
                    check: {
                        id, version: BLOB_CHECK_VERSION, lead, subject: sub.subject, note: 'Seen from straight above. Leave the others. Optional: it helps the district find what each blob is.',
                        detail: `${lead} ${sub.subject}.`, tiles
                    }
                };
            }
        }
        return { reason: 'no blob read has enough unanswered blobs, with a sure yes and a sure no, for a check' };
    }

    inspect(checkId: string): Array<{ tileId: string; role: CheckBlob['role']; clusterId: number; label: string }> | undefined {
        return this.pending.get(checkId)?.blobs.map(b => ({ tileId: b.tileId, role: b.role, clusterId: b.clusterId, label: b.label.label }));
    }

    /** The answer: `selected` the tile ids marked. Every uncertain blob is stored with the answer and its measures, trusted when both controls were answered right; a skipped check stores nothing. */
    answer(checkId: string, selected: string[], skipped = false): { stored: number; controlsPassed: boolean } {
        const p = this.pending.get(checkId);
        if (!p) throw new Error('this blob check is not known (it expired or was answered)');
        this.pending.delete(checkId);
        const sel = new Set(selected);
        const controlsPassed = p.blobs.every(b => b.role === 'uncertain' || (b.role === 'yes') === sel.has(b.tileId));
        if (skipped) return { stored: 0, controlsPassed: false };
        fs.mkdirSync(this.labelsDir, { recursive: true });
        const at = new Date(this.now()).toISOString();
        const lines = p.blobs.filter(b => b.role === 'uncertain').map(b => JSON.stringify({
            version: BLOB_CHECK_VERSION, key: b.key, at, check: p.id, source: b.source, clusterId: b.clusterId, kind: p.kind, subject: p.subject, yes: sel.has(b.tileId), trusted: controlsPassed,
            model: { label: b.label.label, confidence: b.label.confidence, standing: b.label.standing, permanent: b.label.permanent, scanFault: b.label.scanFault },
            evidence: evidenceRow(b.evidence), fields: BLOB_EVIDENCE_FIELDS, landuse: b.evidence.vector.landuse
        }));
        fs.appendFileSync(path.join(this.labelsDir, BLOB_LABELS_FILE), lines.map(l => l + '\n').join(''));
        return { stored: lines.length, controlsPassed };
    }
}
