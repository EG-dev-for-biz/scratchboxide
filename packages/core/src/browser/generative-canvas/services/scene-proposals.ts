/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reviewable agent edits to an open 3D scene (docs/research/2026-11-11-reviewable-scene-edits-design.md, phase 1).
 *
 * An agent tool call that changes a scene already open returns the whole scene as it made it, starting from the copy
 * the request carried (the base). Applying that whole scene would overwrite anything the user changed in the viewport
 * meanwhile. Here it becomes a proposal instead: the structural change from the base to the agent's scene
 * (`computeSceneDelta`), split into hunks (one per top-level field or collection item), applied onto the live scene
 * as a delta, so the user's own edits stand. A hunk whose path the user also changed since the base is a conflict and
 * keeps the user's value. Depending on the review policy a proposal is applied at once or waits for Accept / Reject.
 *
 * Only edits are proposals: a regenerated model (a generator's source or model changed) and a pipeline build's progress
 * (the staged build changed) pass through as before. Hunks are paths into the scene contract; nothing here reads what
 * an object is, only its id and, for a label, its name.
 */

import type { CanvasArtifact, Scene3DData } from '../canvas-types';
import { isOmittedGlbNote } from '../gemini-client';
import { readStagedBuild } from '../primitives/scene3d/stagedBuild/stagedBuildState';
import { GENERATED_KEYS, humanizeOperator } from '../primitives/scene3d/viewportHistoryController';
import { applySceneDelta, computeSceneDelta, deepEqual, SCENE_BOOKKEEPING_KEYS } from './viewport-history-deltas';
import type { ItemChange, SceneDelta } from './viewport-history-deltas';

/** When an agent's edit waits for the user: every edit, only one that removes something (or touches the user's own changes), or none. */
export type SceneReviewPolicy = 'always' | 'removals' | 'never';
export const DEFAULT_SCENE_REVIEW_POLICY: SceneReviewPolicy = 'removals';

export interface ProposalHunk {
    /** `key` for a field, `key/itemId` for a collection item. */
    id: string;
    key: string;
    itemId?: string;
    change: 'add' | 'remove' | 'modify';
    label: string;
    /** The user changed the same path since the base: applying keeps the user's value. */
    conflict?: boolean;
}

export interface SceneProposal {
    /** One per agent turn and scene: later tool calls in the turn replace it. */
    id: string;
    artifactId: string;
    /** The artifact version the request carried. */
    baseVersion: number;
    createdAt: number;
    /** From the operators the agent ran ("Set material, Translate"). */
    label: string;
    delta: SceneDelta;
    hunks: ProposalHunk[];
    /** Operator-log entries the agent added past the base, carried onto the live scene with the change (they label its undo step). */
    log: { operatorStack: unknown[]; actionLog: unknown[] };
    /** `pending`: waiting for Accept / Reject; `applied`: already on the live scene, waiting for Keep / Undo. */
    status: 'pending' | 'applied';
    /** Hunks put on the live scene (status `applied`): what Undo takes back. */
    applied?: string[];
    /**
     * Every value earlier calls of the turn left at hunks they applied, by hunk id: the live scene holding any of them is
     * the agent's own change, no conflict (a scene event can be read before the stage shows the one before it).
     */
    agentLeft?: Record<string, unknown[]>;
}

export interface ProposalApplication {
    data: Scene3DData;
    applied: string[];
    /** Hunks whose path the user had changed: their value kept. */
    keptYours: string[];
}

const IGNORED_KEYS: ReadonlyArray<string> = [...SCENE_BOOKKEEPING_KEYS, ...GENERATED_KEYS];

type Item = { id: string; [key: string]: unknown };
const rec = (scene: Scene3DData) => scene as unknown as Record<string, unknown>;

/**
 * What an agent's scene is relative to the one its request carried: an edit to review, a regenerated model, or a build's
 * progress. A model the request left out (chatRequestBody's note in place of a large glbBase64) is the model it had.
 */
export function sceneUpdateKind(base: Scene3DData, incoming: Scene3DData): 'edit' | 'regenerate' | 'build' {
    for (const key of ['pythonGenerator', 'cppGenerator'] as const) {
        const a = base[key], b = incoming[key];
        const newModel = !!b?.glbBase64 && !isOmittedGlbNote(b.glbBase64) && b.glbBase64 !== a?.glbBase64;
        if (b && (b.sourceCode !== a?.sourceCode || newModel)) return 'regenerate';
    }
    if (!deepEqual(readStagedBuild(base), readStagedBuild(incoming))) return 'build';
    return 'edit';
}

function itemName(item: unknown): string {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = [o.name, o.label, o.title].find(v => typeof v === 'string' && v.trim());
    return (name as string | undefined) ?? String(o.id ?? 'item');
}

function sentenceKey(key: string): string {
    const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function hunkLabel(key: string, change: ProposalHunk['change'], c?: ItemChange): string {
    if (!c) return change === 'remove' ? `${sentenceKey(key)} removed` : `${sentenceKey(key)} ${change === 'add' ? 'set' : 'changed'}`;
    if (change === 'add') return `Added ${itemName(c.after)}`;
    if (change === 'remove') return `Removed ${itemName(c.before)}`;
    const before = (c.before ?? {}) as Record<string, unknown>, after = (c.after ?? {}) as Record<string, unknown>;
    const props = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => k !== 'id' && !deepEqual(before[k], after[k]));
    return `${itemName(c.after)}: ${props.length ? props.map(sentenceKey).join(', ').toLowerCase() : 'changed'}`;
}

function liveItem(live: Scene3DData, key: string, id: string): Item | undefined {
    const list = rec(live)[key];
    return Array.isArray(list) ? (list as Item[]).find(item => item?.id === id) : undefined;
}

/** A hunk the live scene already shows as the agent made it (an earlier call of the turn already applied). */
function alreadyApplied(live: Scene3DData, delta: SceneDelta, h: ProposalHunk): boolean {
    if (!h.itemId) return deepEqual(rec(live)[h.key], delta.fields[h.key].after);
    const c = delta.collections[h.key].find(x => x.id === h.itemId)!;
    return deepEqual(liveItem(live, h.key, h.itemId), c.after);
}

/**
 * The user changed this hunk's path since the base (and not to what the agent made). `left` holds the values earlier
 * calls of the turn put at hunks they applied: the live scene holding one is the agent's own change, not the user's.
 */
function conflicts(live: Scene3DData, delta: SceneDelta, h: ProposalHunk, left?: Record<string, unknown[]>): boolean {
    if (alreadyApplied(live, delta, h)) return false;
    if (leftByAgent(live, h, left)) return false;
    const now = valueAt(live, h);
    if (!h.itemId) return !deepEqual(now, delta.fields[h.key].before);
    return !deepEqual(now, delta.collections[h.key].find(x => x.id === h.itemId)!.before);
}

function valueAt(scene: Scene3DData, h: ProposalHunk): unknown {
    return h.itemId ? liveItem(scene, h.key, h.itemId) : rec(scene)[h.key];
}

/** The live scene holds, at this hunk, a value an earlier call of the turn left there. */
function leftByAgent(live: Scene3DData, h: ProposalHunk, left?: Record<string, unknown[]>): boolean {
    const now = valueAt(live, h);
    const values = left?.[h.id];
    return Array.isArray(values) && values.some(v => deepEqual(now, v));
}

/** Every value a proposal's turn has left at its applied hunks (the next call of the turn reads its own changes by them). */
function valuesLeft(p: SceneProposal): Record<string, unknown[]> {
    const left: Record<string, unknown[]> = {};
    for (const [id, values] of Object.entries(p.agentLeft ?? {})) if (Array.isArray(values)) left[id] = [...values];
    for (const h of p.hunks) {
        if (!(p.applied ?? []).includes(h.id)) continue;
        const after = h.itemId ? p.delta.collections[h.key].find(c => c.id === h.itemId)!.after : p.delta.fields[h.key].after;
        const list = (left[h.id] ??= []);
        if (!list.some(v => deepEqual(v, after))) list.push(after);
    }
    return left;
}

function logGrowth(base: Scene3DData, incoming: Scene3DData): SceneProposal['log'] {
    const past = (a: unknown[] | undefined, b: unknown[] | undefined) => (b ?? []).slice((a ?? []).length);
    return { operatorStack: past(base.operatorStack, incoming.operatorStack), actionLog: past(base.actionLog, incoming.actionLog) };
}

/** The proposal for an agent's edit (`incoming`) to a scene that started as `base`, its conflicts read against `live`; null when it changes nothing. */
export function proposeSceneEdit(args: {
    id: string;
    artifactId: string;
    baseVersion: number;
    base: Scene3DData;
    incoming: Scene3DData;
    live: Scene3DData;
    /** Values earlier calls of the turn left at hunks they applied (`SceneProposal.agentLeft`). */
    agentLeft?: Record<string, unknown[]>;
    now?: number;
}): SceneProposal | null {
    const delta = computeSceneDelta(args.base, args.incoming, { ignoreKeys: IGNORED_KEYS, clone: true });
    if (!delta) return null;
    const hunks: ProposalHunk[] = [];
    for (const [key, f] of Object.entries(delta.fields)) {
        const change: ProposalHunk['change'] = f.after === undefined ? 'remove' : f.before === undefined ? 'add' : 'modify';
        hunks.push({ id: key, key, change, label: hunkLabel(key, change) });
    }
    for (const [key, changes] of Object.entries(delta.collections)) {
        for (const c of changes) {
            const change: ProposalHunk['change'] = c.after === undefined ? 'remove' : c.before === undefined ? 'add' : 'modify';
            hunks.push({ id: `${key}/${c.id}`, key, itemId: c.id, change, label: hunkLabel(key, change, c) });
        }
    }
    // a hunk the live scene already shows as the agent made it, or as an earlier call of this turn left it, is no conflict
    for (const h of hunks) if (conflicts(args.live, delta, h, args.agentLeft)) h.conflict = true;
    const log = logGrowth(args.base, args.incoming);
    const ops = [...log.operatorStack, ...log.actionLog]
        .map(o => (o as { operator?: unknown })?.operator)
        .filter((o): o is string => typeof o === 'string');
    const names = [...new Set(ops.map(humanizeOperator))];
    return {
        id: args.id,
        artifactId: args.artifactId,
        baseVersion: args.baseVersion,
        createdAt: args.now ?? Date.now(),
        label: names.length ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}` : `${hunks.length} change${hunks.length === 1 ? '' : 's'}`,
        delta,
        hunks,
        log,
        status: 'pending',
        ...(args.agentLeft && Object.keys(args.agentLeft).length ? { agentLeft: args.agentLeft } : {})
    };
}

/** Whether a proposal waits for the user under `policy`: a conflict always does. */
export function proposalNeedsReview(p: SceneProposal, policy: SceneReviewPolicy = DEFAULT_SCENE_REVIEW_POLICY): boolean {
    if (p.hunks.some(h => h.conflict)) return true;
    if (policy === 'always') return true;
    if (policy === 'never') return false;
    return p.hunks.some(h => h.change === 'remove');
}

/** The scene with the agent's log entries appended, less any it already holds (an earlier call of the turn carried them). */
function withLog(data: Scene3DData, log: SceneProposal['log']): Scene3DData {
    const fresh = (have: unknown[] | undefined, add: unknown[]) => add.filter(e => !(have ?? []).some(h => deepEqual(h, e)));
    const stack = fresh(data.operatorStack, log.operatorStack), actions = fresh(data.actionLog, log.actionLog);
    if (!stack.length && !actions.length) return data;
    return {
        ...data,
        operatorStack: [...(data.operatorStack ?? []), ...stack] as Scene3DData['operatorStack'],
        actionLog: [...(data.actionLog ?? []), ...actions] as Scene3DData['actionLog']
    };
}

/** Applies a proposal onto the live scene as a delta: the user's own changes since the base stand, conflicting hunks keep the user's value. */
export function applySceneProposal(live: Scene3DData, p: SceneProposal): ProposalApplication {
    const take: SceneDelta = { fields: {}, collections: {} };
    const applied: string[] = [], keptYours: string[] = [];
    for (const h of p.hunks) {
        if (conflicts(live, p.delta, h, p.agentLeft)) { keptYours.push(h.id); continue; }
        if (alreadyApplied(live, p.delta, h)) continue;
        applied.push(h.id);
        if (!h.itemId) take.fields[h.key] = p.delta.fields[h.key];
        else (take.collections[h.key] ??= []).push(p.delta.collections[h.key].find(c => c.id === h.itemId)!);
    }
    const changed = applied.length ? applySceneDelta(live, take, 'apply', true) : live;
    return { data: withLog(changed, p.log), applied, keptYours };
}

/**
 * Takes an applied proposal back off the live scene: each hunk it put there returns to its value before, unless the user
 * has changed it since (then theirs stands, reported in `keptYours`).
 */
export function revertSceneProposal(live: Scene3DData, p: SceneProposal): ProposalApplication {
    const take: SceneDelta = { fields: {}, collections: {} };
    const reverted: string[] = [], keptYours: string[] = [];
    for (const h of p.hunks) {
        if (!(p.applied ?? []).includes(h.id)) continue;
        // the agent's: as this proposal made it, or as an earlier call of its turn left it
        if (!alreadyApplied(live, p.delta, h) && !leftByAgent(live, h, p.agentLeft)) { keptYours.push(h.id); continue; }
        reverted.push(h.id);
        if (!h.itemId) take.fields[h.key] = p.delta.fields[h.key];
        else (take.collections[h.key] ??= []).push(p.delta.collections[h.key].find(c => c.id === h.itemId)!);
    }
    return { data: reverted.length ? applySceneDelta(live, take, 'revert', true) : live, applied: reverted, keptYours };
}

/**
 * Routes an agent's artifact for the open scene: what the stage should show now, and the proposal for the review bar:
 * `pending` (held: the stage keeps the live scene) or `applied` (already on the stage, Keep or Undo). `base` is the
 * artifact the request carried, `live` the stage's artifact now (the user may have edited it since). Anything that is
 * not an edit to that open scene passes through unchanged.
 */
export function routeAgentSceneArtifact(args: {
    incoming: CanvasArtifact;
    base: CanvasArtifact | undefined;
    live: CanvasArtifact | undefined;
    proposalId: string;
    /** This turn's earlier proposal for the scene: the hunks it already applied stay what Undo / Reject takes back. */
    previous?: SceneProposal;
    policy?: SceneReviewPolicy;
    now?: number;
}): { show: CanvasArtifact; proposal?: SceneProposal } {
    const { incoming, base } = args;
    if (incoming.type !== '3d-scene' || !base || base.type !== '3d-scene' || base.id !== incoming.id || !base.data || !incoming.data) {
        return { show: incoming };
    }
    const live = args.live && args.live.id === incoming.id && args.live.type === '3d-scene' && args.live.data ? args.live : base;
    const baseData = base.data as Scene3DData, incomingData = incoming.data as Scene3DData, liveData = live.data as Scene3DData;
    if (sceneUpdateKind(baseData, incomingData) !== 'edit') return { show: incoming };
    const previous = args.previous?.id === args.proposalId ? args.previous : undefined;
    const p = proposeSceneEdit({
        id: args.proposalId, artifactId: incoming.id, baseVersion: base.version ?? 1,
        base: baseData, incoming: incomingData, live: liveData, now: args.now,
        agentLeft: previous ? valuesLeft(previous) : undefined
    });
    const version = Math.max(incoming.version ?? 1, (live.version ?? 1) + 1);
    if (!p) {
        const data = withLog(liveData, logGrowth(baseData, incomingData));
        return { show: data === liveData ? live : { ...incoming, version, data } };
    }
    const carried = (previous?.applied ?? []).filter(id => p.hunks.some(h => h.id === id));
    if (proposalNeedsReview(p, args.policy)) return { show: live, proposal: { ...p, applied: carried } };
    const done = applySceneProposal(liveData, p);
    const proposal: SceneProposal = { ...p, status: 'applied', applied: [...new Set([...carried, ...done.applied])] };
    // nothing new to put on the stage (the turn's change is already there): it stays as it is, no new version
    if (!done.applied.length) return { show: done.data === liveData ? live : { ...live, data: done.data }, proposal };
    return { show: { ...incoming, version, data: done.data }, proposal };
}

const decided = new Set<string>();

/** The user accepted, kept, rejected or undid this proposal: its turn must not put it back (useSendMessage reads this). */
export function markProposalDecided(id: string): void {
    decided.add(id);
}

export function isProposalDecided(id: string): boolean {
    return decided.has(id);
}

/** The session's proposals with `p` in place of any earlier one of its id, or of the same scene (one waits per scene). */
export function upsertProposal(list: SceneProposal[] | undefined, p: SceneProposal): SceneProposal[] {
    return [...(list ?? []).filter(x => x.id !== p.id && x.artifactId !== p.artifactId), p];
}

/** The session's proposals without the one for `artifactId`. */
export function dropProposal(list: SceneProposal[] | undefined, artifactId: string): SceneProposal[] {
    return (list ?? []).filter(x => x.artifactId !== artifactId);
}
