/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { Scene3DData } from '../../canvas-types';
import { ViewportHistory } from '../../services/viewport-history';
import {
    SCENE_BOOKKEEPING_KEYS,
    SceneEditEntry,
    applySceneDelta,
    computeSceneDelta,
    deepEqual
} from '../../services/viewport-history-deltas';
import type { ItemChange, LiveEdit, SceneDelta } from '../../services/viewport-history-deltas';
import { readStagedBuild } from './stagedBuild/stagedBuildState';

export type OpInfo = { operator: string; params?: any };

/** What a caller says about an edit it is making; everything is optional free text / values. */
export interface HistoryEditMeta {
    label?: string;
    /** Three.js side of the edit (sparse vertex delta, transform, geometry swap). */
    live?: LiveEdit | null;
    /** false: the edit's scene-data change is not part of it (the live edit alone is the entry). */
    scene?: boolean;
    /** false: never fold this entry into the previous one (a gizmo drag is always its own entry). */
    coalesce?: boolean;
    /** The live edit is the step itself: dropped as a whole when its objects are gone (a sculpt stroke). */
    requireLive?: boolean;
    /** Object to select again on redo (defaults to params.objectId). */
    selectionId?: string | null;
}

export interface ViewportHistoryControllerArgs {
    /** Writes scene data and notifies the owner; never records history itself. */
    commit: (update: (prev: Scene3DData) => Scene3DData, opInfo: OpInfo) => void;
    getSelectedId: () => string | null;
    /** Selects the object with this id (null clears); called after undo / redo. */
    restoreSelection: (id: string | null) => void;
}

/** Generated results that arrive without a user edit: never part of an undoable step. */
/** Scene keys holding generated results (a pipeline's build, a generator's source and model), never an edit's. */
export const GENERATED_KEYS = ['stagedBuild', 'pythonGenerator', 'cppGenerator'];

export function humanizeOperator(operator: string): string {
    const words = operator.replace(/^sb_/, '').replace(/[_\-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Edit';
}

function targetName(scene: Scene3DData, id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const hit = (scene.customMeshes || []).find(m => m.id === id || m.name === id);
    return hit?.name || id;
}

/** Label for an edit: the caller's own, else the operator name plus the object it names. */
export function describeEdit(opInfo: OpInfo | undefined, scene: Scene3DData, meta?: HistoryEditMeta): string {
    if (meta?.label) return meta.label;
    if (!opInfo) return 'Edit';
    const name = targetName(scene, opInfo.params?.objectId ?? opInfo.params?.mesh?.id);
    return name ? `${humanizeOperator(opInfo.operator)}: ${name}` : humanizeOperator(opInfo.operator);
}

/** Staged-layer objects whose explicit material differs: undo restores the old material on the current object. */
function stagedMaterialChanges(prev: Scene3DData, next: Scene3DData, staged: ReadonlySet<string>): ItemChange[] {
    const before = new Map((prev.objects ?? []).map(o => [o.id, o]));
    const out: ItemChange[] = [];
    (next.objects ?? []).forEach((item, index) => {
        const old = before.get(item.id);
        if (!old || !staged.has(item.id) || deepEqual(old.material, item.material)) return;
        const { material: _drop, ...rest } = item;
        out.push({ id: item.id, index, before: old.material === undefined ? rest : { ...rest, material: old.material }, after: item });
    });
    return out;
}

function mergeMaterialEdits(delta: SceneDelta | null, edits: ItemChange[]): SceneDelta | null {
    if (edits.length === 0) return delta;
    const out: SceneDelta = delta ?? { fields: {}, collections: {} };
    out.collections.objects = [...(out.collections.objects ?? []), ...edits];
    return out;
}

function layerObjectIds(scene: Scene3DData): Set<string> {
    return new Set((readStagedBuild(scene)?.layers ?? []).map(l => l.objectId));
}

/**
 * Turns scene edits into entries on one ViewportHistory and replays them. React-free so the same
 * logic is exercised directly by tests; useViewportHistory only gives it a component lifetime.
 */
export class ViewportHistoryController {
    readonly history: ViewportHistory;
    private pending: Array<(d: Scene3DData) => Scene3DData> = [];
    private readonly target = {
        applyDelta: (delta: SceneDelta, direction: 'apply' | 'revert') => {
            this.pending.push(d => applySceneDelta(d, delta, direction));
        }
    };

    constructor(private readonly args: ViewportHistoryControllerArgs, history?: ViewportHistory) {
        this.history = history ?? new ViewportHistory({ onRestoreSelection: id => this.args.restoreSelection(id) });
    }

    undo = (): boolean => this.replay('undo');
    redo = (): boolean => this.replay('redo');

    private replay(direction: 'undo' | 'redo'): boolean {
        this.pending = [];
        const entry = direction === 'undo' ? this.history.undo() : this.history.redo();
        const patches = this.pending;
        this.pending = [];
        if (!entry) return false;
        // One scene commit per undo / redo. It also tells the agent, through the operator log it reads,
        // that the user reversed this change, so it does not re-apply stale state.
        this.args.commit(d => ({ ...patches.reduce((acc, p) => p(acc), d) }), {
            operator: direction === 'undo' ? 'sb_undo' : 'sb_redo',
            params: {
                target: 'viewport-history',
                label: entry.label,
                note: direction === 'undo'
                    ? `The user undid "${entry.label}" in the viewport; the scene no longer contains that change.`
                    : `The user redid "${entry.label}" in the viewport.`
            }
        });
        return true;
    }

    /** Called for every user edit that carries operator info (`meta === false`: view-only, not recorded). */
    recordSceneEdit = (prev: Scene3DData, next: Scene3DData, opInfo: OpInfo | undefined, meta?: HistoryEditMeta | false): void => {
        if (meta === false || this.history.isReplaying || !opInfo) return;
        const delta = meta?.scene === false ? null : computeSceneDelta(prev, next, { ignoreKeys: SCENE_BOOKKEEPING_KEYS });
        const live = meta?.live ?? null;
        if (!delta && !live) return;
        const redoSel = meta?.selectionId !== undefined ? meta.selectionId : (opInfo.params?.objectId ?? opInfo.params?.mesh?.id);
        this.history.record(new SceneEditEntry({
            label: describeEdit(opInfo, next, meta),
            delta,
            live,
            target: this.target,
            mergeable: meta?.coalesce !== false,
            requireLive: meta?.requireLive,
            selection: { undo: this.args.getSelectedId(), redo: typeof redoSel === 'string' || redoSel === null ? redoSel : undefined }
        }));
    };

    /** An edit with no scene-data change (a sculpt stroke, a part inside a loaded model moved). */
    recordLiveEdit = (label: string, live: LiveEdit | null, meta?: Pick<HistoryEditMeta, 'selectionId'>): void => {
        if (!live || this.history.isReplaying) return;
        const redoSel = meta?.selectionId !== undefined ? meta.selectionId : this.args.getSelectedId();
        this.history.record(new SceneEditEntry({
            label, delta: null, live, target: this.target, requireLive: true,
            selection: { undo: this.args.getSelectedId(), redo: redoSel }
        }));
    };

    /** Scene data changed from outside (the agent): one entry per tool call, or a reset for regenerated content. */
    recordExternalChange = (prev: Scene3DData, next: Scene3DData): void => {
        if (this.history.isReplaying) return;
        const generated = (next.pythonGenerator?.glbBase64 && next.pythonGenerator.glbBase64 !== prev.pythonGenerator?.glbBase64)
            || (next.cppGenerator?.glbBase64 && next.cppGenerator.glbBase64 !== prev.cppGenerator?.glbBase64)
            || (next.pythonGenerator && next.pythonGenerator.sourceCode !== prev.pythonGenerator?.sourceCode)
            || (next.cppGenerator && next.cppGenerator.sourceCode !== prev.cppGenerator?.sourceCode);
        if (generated) {
            // New generated content replaces what earlier edits were made against.
            this.history.clear();
            return;
        }
        // An agent tool call logs the operators it ran (an atomic batch only in the action log); a change that
        // logged nothing is not an edit to undo.
        const ran = (scene: Scene3DData) => [scene.operatorStack ?? [], scene.actionLog ?? []] as const;
        const [stackBefore, logBefore] = ran(prev);
        const [stackAfter, logAfter] = ran(next);
        const added = stackAfter.length > stackBefore.length
            ? stackAfter.slice(stackBefore.length)
            : logAfter.length > logBefore.length ? logAfter.slice(logBefore.length) : [];
        if (added.length === 0) return;
        const staged = new Set([...layerObjectIds(prev), ...layerObjectIds(next)]);
        const delta = computeSceneDelta(prev, next, {
            ignoreKeys: [...SCENE_BOOKKEEPING_KEYS, ...GENERATED_KEYS],
            ignoreItem: (key, item) => key === 'objects' && staged.has(item?.id)
        });
        // Staged layers' geometry is a pipeline result and stays out of history; an explicit material set on one
        // (sb_set_material_pbr) is an edit of the user's own, recorded with the object as it stands now.
        const materialEdits = stagedMaterialChanges(prev, next, staged);
        const merged = mergeMaterialEdits(delta, materialEdits);
        if (!merged) return;
        const names = Array.from(new Set(added.map(o => humanizeOperator(o.operator))));
        this.history.record(new SceneEditEntry({
            label: `Agent: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}`,
            delta: merged,
            target: this.target,
            selection: { undo: this.args.getSelectedId() }
        }));
    };
}
