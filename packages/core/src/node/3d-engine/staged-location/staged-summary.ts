/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the model and the user are told about a staged build: the ≤ 200-character digest (the part chat history keeps
 * of a card), the summary sentences, and the context line a later turn carries (stagedBuildContext). One function per
 * rule of STAGED_SUMMARY_RULES; every number carries a unit and every count is read from the result fields.
 */

import {
    PHOTO_CORRECTION_TOLERANCE_M,
    STAGED_SUMMARY_LIMITS,
    type DegradationRecord,
    type StagedBuildState,
    type StagedLocationResult,
    type StageSummary,
    type VisionModelUse
} from '../../../common/spatial/staged-location-contracts';
import { describeTrees } from '../location-clay-pipeline';

/** Everything the summary reads: the result fields, plus the facts only the run knows. */
export interface StagedSummaryInput extends Omit<StagedLocationResult, 'digest' | 'summary' | 'artifact'> {
    runId: string;
    /** What the remesh changed that the scan did not hold, in words with numbers (from tile_refine and strip stats). */
    remeshNote?: string;
    /** The scanned trees put back after a failed tree stage. */
    treesPutBack?: { triangles: number; crowns: number; reason: string };
    /** Elements dropped because their evidence does not show or resolve them (rules 9-12). */
    droppedNotResolvable?: number;
    /** Vertex-floor exemptions the gate asked for and refused, with why: their layers were counted against the floor. */
    exemptionsRefused?: string[];
    /** Exempted layers that are partly inferred or grown rather than measured, with the share. */
    exemptInferred?: string[];
}

/** "1,234". */
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const m1 = (v: number) => `${v.toFixed(1)} m`;
const cm = (v: number) => `${(v * 100).toFixed(1)} cm`;
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function stage(input: Pick<StagedSummaryInput, 'stages'>, id: string): StageSummary | undefined {
    return input.stages.find(s => s.stage === id);
}

/**
 * A stage's layer is on screen: the stage committed, or degraded and still left a layer. A degraded stage is a simpler
 * version of the same data (a remeshed scan, a flattened scan, trees with a crown kept as scanned), not an absent one,
 * so what the headline says is mounted follows the layers and never the status alone.
 */
function mounted(input: Pick<StagedSummaryInput, 'stages'>, id: string): boolean {
    const s = stage(input, id);
    return !!s && (s.status === 'committed' || s.status === 'degraded') && s.layerIds.length > 0;
}

function thinkingWords(model: VisionModelUse): string {
    return 'level' in model.thinking ? `thinking ${model.thinking.level.toLowerCase()}` : `thinking budget ${n(model.thinking.budget)} tokens`;
}

/** The model that read (or was asked to read) the facade detail, whichever record holds it. */
function visionModelOf(input: StagedSummaryInput): VisionModelUse | undefined {
    return input.ornament?.model ?? input.degradations.find(d => d.model)?.model;
}

// ----------------------------------------------------------------------------------------------------------------
// digest
// ----------------------------------------------------------------------------------------------------------------

/** "<what> fell to <rung> (<reasonCode>[, <model> <status>])": one degradation, short. */
function shortDegradation(d: DegradationRecord): string {
    const model = d.model && d.model.outcome === 'failed' ? `, ${d.model.used || d.model.requested}${d.model.error ? ` ${(/\b\d{3}\b/.exec(d.model.error) ?? [''])[0]}` : ''}`.trimEnd() : '';
    return `${d.stage} fell to ${d.fellTo} (${d.reasonCode}${model})`;
}

/** "<stage>: <reasonCode>[ (<model> <status>)]": one degradation, as short as it gets. */
function codeDegradation(d: DegradationRecord): string {
    const model = d.model && d.model.outcome === 'failed' ? ` (${d.model.used || d.model.requested}${d.model.error ? ` ${(/\b\d{3}\b/.exec(d.model.error) ?? [''])[0]}` : ''})`.replace(' )', ')') : '';
    return `${d.stage}: ${d.reasonCode}${model}`;
}

/**
 * Rule "digest": status and degradations first, then the retry handle, within 200 characters: each degradation in
 * full ("remesh fell to … (remesh_failed)") when they all fit, else by stage and reason code, else as many as fit
 * and the count of the rest.
 */
export function stagedDigest(input: StagedSummaryInput): string {
    const max = STAGED_SUMMARY_LIMITS.digestMaxChars;
    const done = input.stages.filter(s => s.status === 'committed').map(s => s.stage);
    // a degraded stage that left a layer is on screen even when no stage committed whole
    const shown = input.stages.filter(s => s.status === 'degraded' && mounted(input, s.stage)).map(s => s.stage);
    const head = `Staged build ${input.status}: ${done.length ? `${done.join(', ')} committed` : shown.length ? `${shown.join(', ')} mounted, degraded` : 'nothing committed'}`;
    const retryStages = [...new Set(input.degradations.filter(d => d.transient && d.retry).map(d => d.retry!.args.retryStage))];
    const stopped = input.stages.filter(s => s.status === 'stopped').map(s => s.stage);
    const retry = `retry retryRunId ${input.runId}${retryStages.length ? ` stage ${retryStages[0]}` : stopped.length ? ` stage ${stopped[0]}` : ''}.`;
    const degr = input.degradations.filter(d => d.reasonCode !== 'pass_through');
    const lead = input.status === 'stopped' && stopped.length ? [`stopped before ${stopped.join(', ')}`] : [];
    const compose = (parts: string[]) => `${head}${parts.length ? `; ${parts.join('; ')}` : ''}; ${retry}`;
    for (const form of [shortDegradation, codeDegradation]) {
        const text = compose([...lead, ...degr.map(form)]);
        if (text.length <= max) return text;
    }
    // as many short forms as fit, the count of the rest, and the retry handle
    const parts = [...lead, ...degr.map(codeDegradation)];
    for (let keep = parts.length - 1; keep >= 0; keep--) {
        const text = `${head}${keep ? `; ${parts.slice(0, keep).join('; ')}` : ''}; +${parts.length - keep} more degraded; ${retry}`;
        if (text.length <= max) return text;
    }
    return `${`Staged build ${input.status}; ${degr.length} degraded`.slice(0, max - retry.length - 2)}; ${retry}`.slice(0, max);
}

// ----------------------------------------------------------------------------------------------------------------
// summary rules
// ----------------------------------------------------------------------------------------------------------------

/** Rule "mounted": what is mounted and from what. */
export function mountedSentence(input: StagedSummaryInput): string {
    const p = input.place;
    const paren: string[] = [];
    if (p.resolvedAddress && p.resolvedAddress !== p.query) paren.push(p.resolvedAddress);
    if (input.structure) paren.push(`${m1(input.structure.geocodeToStructureM)} from the geocoded point`);
    const name = paren.length ? `${p.query} (${paren.join(', ')})` : p.query;
    // a district the leaf-tile cap cut short says how far it reached and how far was asked
    const asked = input.extraction.requestedRadiusM;
    const capped = asked !== undefined && input.extraction.radiusM < asked - 0.5;
    const extent = input.extraction.sizedTo === 'structure'
        ? `, extracted ${m1(input.extraction.radiusM)} around the structure`
        : capped ? ` within ${n(input.extraction.radiusM)} m (${n(asked!)} m asked for; the leaf-tile cap stopped it short)` : ` within ${n(input.extraction.radiusM)} m`;
    const layers: string[] = [];
    if (mounted(input, 'remesh')) {
        layers.push(input.degradations.some(d => d.stage === 'remesh' && d.provenanceAfter === 'scan-flattened') ? 'the scan with its facades flattened' : 'the remeshed scan');
    } else if (mounted(input, 'tiles')) layers.push('the scan as downloaded');
    const fit = input.structureFit;
    if (fit?.accepted && mounted(input, 'fit')) {
        const unobserved = fit.unobservedFaceAreaM2 > 0 ? `; ${fit.unobservedFaceAreaM2.toFixed(1)} m² of faces placed by the fit without scan samples` : '';
        layers.push(`a scan-fitted rebuild of ${n(fit.primitives)} primitives (${cm(fit.scanToFitRmsM)} rms to the scan, ${Math.round(fit.coverage * 100)}% of the visible surface${unobserved})`);
    }
    if (input.ornament && input.ornament.elements > 0 && mounted(input, 'detail')) layers.push(`${n(input.ornament.elements)} photo-inferred details`);
    if (input.trees && input.trees.count > 0 && !input.treesPutBack && mounted(input, 'trees')) layers.push(`${n(input.trees.count)} trees grown to the measured crown`);
    if (input.treesPutBack) layers.push('the scanned trees put back as scanned');
    const list = layers.length > 1 ? `${layers.slice(0, -1).join(', ')} and ${layers[layers.length - 1]}` : layers[0] ?? 'nothing yet';
    return `${name} in clay from Google 3D Tiles${extent}: ${list}.`;
}

/** Rule "evidence-and-model". */
export function evidenceSentence(input: StagedSummaryInput): string {
    const model = visionModelOf(input);
    if (!model) return '';
    const fallback = model.skipped.length
        ? ` ${model.used} read them because ${model.skipped.map(s => `${s.model} was not served (${(/\b\d{3}\b/.exec(s.reason) ?? ['not found'])[0]})`).join(' and ')}.`
        : '';
    if (model.outcome === 'failed') {
        const tried = model.used || model.requested;
        return `No detail: ${tried} (${thinkingWords(model)}) ${model.error ? `failed: ${model.error}` : 'gave no usable reply'}; the fitted faces stay flat.${fallback}`;
    }
    const ev = input.ornament?.evidence;
    const sources = ev
        ? `${n(ev.tileOrthos)} facade view${ev.tileOrthos === 1 ? '' : 's'} of the tile photos${ev.streetView ? ` and ${n(ev.streetView)} Street View image${ev.streetView === 1 ? '' : 's'} (© Google)` : ''}`
        : 'the tile photos';
    return `The details were read by ${model.used} (${thinkingWords(model)}, ${s1(model.ms)}) from ${sources}.${fallback}`;
}

/** The draft survey: how many faces, the cost, what it measured; hints only, never called measured geometry. */
export function surveySentence(input: StagedSummaryInput): string {
    const h = input.materialHints;
    if (!h) return '';
    const faces = h.faces.filter(f => !f.skipped);
    const colours = faces.reduce((c, f) => c + (f.palette?.colours.length ?? 0), 0);
    return `The draft survey read ${n(faces.length)} of ${n(h.faces.length)} faces from ${n(h.cost.images)} Street View image${h.cost.images === 1 ? '' : 's'} (© Google) in ${n(h.cost.visionCalls)} call (${s1(h.cost.seconds * 1000)}); its materials are photo-inferred hints and its ${n(colours)} colour${colours === 1 ? '' : 's'} are measured from the photo pixels, not used as textures.`;
}

/** Rule "photo-inferred-wording". */
export function photoInferredSentence(input: StagedSummaryInput): string {
    const o = input.ornament;
    if (!o || o.elements === 0) return '';
    const dropped = input.droppedNotResolvable ?? 0;
    return `They are photo-inferred, confidence ${o.confidence.min.toFixed(2)}–${o.confidence.max.toFixed(2)}${dropped ? `; ${n(dropped)} element${dropped === 1 ? ' was' : 's were'} dropped as not resolvable in ${dropped === 1 ? 'its' : 'their'} evidence` : ''}.`;
}

/** Rule "corrections": one sentence each, accepted ones only (a rejected correction changes nothing). */
export function correctionSentences(input: StagedSummaryInput): string[] {
    return (input.structureFit?.corrections ?? []).filter(c => c.check.accepted).map(c =>
        `Primitive ${c.primitiveId} was photo-corrected from ${c.key} ${c.from.toFixed(2)} to ${c.to.toFixed(2)}; its scan residual went from ${cm(c.check.residualBefore.rmsM)} to ${cm(c.check.residualAfter.rmsM)} rms, within the ${Math.round(PHOTO_CORRECTION_TOLERANCE_M * 100)} cm tolerance the photos allow.`);
}

/** Rule "degradations": one sentence per degraded part, at most five, pass-through regions aggregated. */
export function degradationSentences(input: StagedSummaryInput): string[] {
    const limit = STAGED_SUMMARY_LIMITS.degradedPartsWrittenOut;
    const passThrough = input.degradations.filter(d => d.reasonCode === 'pass_through');
    const others = input.degradations.filter(d => d.reasonCode !== 'pass_through');
    const out = others.slice(0, limit).map(d => `${upperFirst(d.part.description)} fell to ${d.fellTo}: ${lowerFirst(d.reason).replace(/\.$/, '')}.`);
    if (others.length > limit) out.push(`And ${n(others.length - limit)} more (listed in degradations).`);
    if (passThrough.length) {
        const area = input.structureFit?.passThroughAreaM2;
        out.push(`${n(passThrough.length)} region${passThrough.length === 1 ? '' : 's'}${area !== undefined ? ` (${area.toFixed(1)} m²)` : ''} kept as scanned where no fitted shape explained the scan.`);
    }
    return out;
}

/** Rule "trees". */
export function treesSentence(input: StagedSummaryInput): string {
    if (input.treesPutBack) {
        const t = input.treesPutBack;
        return `The tree stage failed (${t.reason.replace(/\.$/, '')}), so the scanned trees were put back, labelled as scanned (${n(t.triangles)} triangles over ${n(t.crowns)} measured crowns).`;
    }
    const t = input.trees;
    if (!t) return '';
    // the outcome, then the budget, the crowns kept as scanned or taken out, and what closing the ground added (not in the scan)
    const detail = describeTrees(t, input.extraction.sizedTo === 'structure').trim();
    return t.measured > 0 ? `Trees, grown to the measured crown: ${detail}` : detail;
}

/** Rule "resolution": the scan's and the photo's resolution, kept apart. */
export function resolutionSentence(input: StagedSummaryInput): string {
    const l = input.sourceLimits;
    // the median triangle edge is measured for an isolated structure only; a district states the leaf error alone
    const scan = l.meshResolvableM > 0 && l.meshEdgeP50M > 0
        ? `The scan resolves shapes of about ${l.meshResolvableM.toFixed(1)} m (median triangle edge ${l.meshEdgeP50M.toFixed(2)} m, leaf error ${l.leafGeometricErrorM.toFixed(1)} m)`
        : `The scan's leaf tiles have a geometric error of ${l.leafGeometricErrorM.toFixed(1)} m`;
    const photo = l.photoResolvableM > 0 ? `; the photo texture resolves about ${l.photoResolvableM.toFixed(2)} m (${Math.round(l.texelM * 100)} cm texels)` : '';
    return `${scan}${photo}. Finer detail is photo-inferred.`;
}

/** Rule "remesh-changes". */
export function remeshChangesSentence(input: StagedSummaryInput): string {
    return input.remeshNote && mounted(input, 'remesh') ? `What the remesh changed that the scan did not hold: ${input.remeshNote.replace(/\.$/, '')}.` : '';
}

/** Rule "timings-and-cache". */
export function timingsSentence(input: StagedSummaryInput): string {
    const per = input.stages.filter(s => s.timings.ms !== undefined && s.status !== 'skipped' && s.status !== 'pending')
        .map(s => `${s.stage} ${((s.timings.ms ?? 0) / 1000).toFixed(1)}`);
    const cached = input.stages.filter(s => s.timings.cached);
    const dates = [...new Set(cached.map(s => (s.timings.builtAtMs ? new Date(s.timings.builtAtMs).toISOString().slice(0, 10) : '')).filter(Boolean))];
    const cache = cached.length ? `; ${cached.map(s => s.stage).join(', ')} from cache${dates.length ? ` (built ${dates.join(', ')})` : ''}` : '';
    const waited = input.stages.reduce((s, x) => s + (x.timings.waitedForEngineMs ?? 0), 0);
    const engine = waited >= 1000 ? `; ${s1(waited)} of it waiting for the native engine to build` : '';
    return `Built in ${s1(input.timingsMs.total)} (${per.join(', ')} s)${cache}${engine}.`;
}

/** Rule "stop", from the stages alone: the finished result and the stopped scene's state both phrase it this way. */
export function stopText(stages: ReadonlyArray<Pick<StageSummary, 'title' | 'status' | 'timings'>>, runId: string): string {
    const done = stages.filter(s => s.status === 'committed' || s.status === 'degraded');
    const last = [...done].sort((a, b) => (a.timings.endedAtMs ?? 0) - (b.timings.endedAtMs ?? 0)).pop();
    const notBuilt = stages.filter(s => s.status === 'stopped' || s.status === 'pending').map(s => s.title.toLowerCase());
    const list = notBuilt.length > 1 ? `${notBuilt.slice(0, -1).join(', ')} and ${notBuilt[notBuilt.length - 1]}` : notBuilt[0];
    return `Stopped after ${last ? `the ${last.title.toLowerCase()}` : 'the start'}; ${list ? `${list} ${notBuilt.length === 1 ? 'was' : 'were'} not built, and ` : ''}the finished stages stay in the scene. Retry with retryRunId ${runId}.`;
}

/** Rule "stop". */
export function stopSentence(input: StagedSummaryInput): string {
    if (input.status !== 'stopped') return '';
    return stopText(input.stages, input.runId);
}

/** Rule "gate-exemptions". */
export function gateSentence(input: StagedSummaryInput): string {
    const g = input.complexityGate;
    const inferred = input.exemptInferred?.length ? ` Not all of it is measurement: ${input.exemptInferred.join('; ')}.` : '';
    const exempt = g.exemptions.length ? `Exempt from the vertex floor, as measured geometry: ${g.exemptions.join('; ')}.${inferred}` : '';
    // the verdict is reported, never thrown: a staged build degrades rather than fails the gate
    const verdict = g.passed ? '' : `The geometric complexity gate did not pass (${g.violations.map(v => v.replace(/\.$/, '')).join('; ')}).`;
    const refused = input.exemptionsRefused?.length ? `Not exempt from the vertex floor: ${input.exemptionsRefused.join('; ')}.` : '';
    return [exempt, refused, verdict].filter(Boolean).join(' ');
}

function upperFirst(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function lowerFirst(s: string): string { return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s; }

/** The digest and the summary, in rule order. */
export function summarizeStagedBuild(input: StagedSummaryInput): { digest: string; summary: string } {
    const sentences = [
        stopSentence(input),
        mountedSentence(input),
        surveySentence(input),
        evidenceSentence(input),
        photoInferredSentence(input),
        ...correctionSentences(input),
        ...degradationSentences(input),
        treesSentence(input),
        resolutionSentence(input),
        remeshChangesSentence(input),
        gateSentence(input),
        timingsSentence(input)
    ].filter(Boolean);
    return { digest: stagedDigest(input), summary: sentences.join(' ') };
}

// ----------------------------------------------------------------------------------------------------------------
// the model's context line on a later turn
// ----------------------------------------------------------------------------------------------------------------

/**
 * One line ahead of the 3D scene summary when the active scene holds a staged build: its run state, each stage's
 * status, the degradations, the retry handle and the vision model, at most 1,500 characters. Empty otherwise.
 */
export function stagedBuildContext(sceneData: { stagedBuild?: StagedBuildState } | undefined | null): string {
    const sb = sceneData?.stagedBuild;
    if (!sb || sb.schema !== 'scratchbox.staged-build/2') return '';
    const max = STAGED_SUMMARY_LIMITS.contextLineMaxChars;
    const stages = Object.fromEntries(sb.stages.map(s => [s.stage, s.status]));
    const vm = sb.visionModel;
    // a Stop (or a dropped connection) leaves no result: the state itself names what was not built and how to resume it
    const stopped = sb.runState === 'stopped' || sb.runState === 'interrupted';
    const stoppedStages = stopped ? sb.stages.filter(s => s.status === 'stopped').map(s => s.stage) : [];
    const line = (degradations: Array<{ stage: string; reasonCode: string; transient: boolean }>, more: number) => `[Staged location build: ${JSON.stringify({
        runState: sb.runState,
        stages,
        degradations,
        ...(more ? { moreDegradations: more } : {}),
        ...(sb.retry ? { retry: sb.retry } : stoppedStages.length ? { retry: { retryRunId: sb.runId, stages: stoppedStages } } : {}),
        ...(stopped ? { stop: stopText(sb.stages, sb.runId) } : {}),
        ...(vm ? { visionModel: { used: vm.used, thinking: vm.thinking, outcome: vm.outcome } } : {})
    })}]\n`;
    const all = sb.degradations.map(d => ({ stage: d.stage, reasonCode: d.reasonCode, transient: d.transient }));
    for (let keep = all.length; keep >= 0; keep--) {
        const text = line(all.slice(0, keep), all.length - keep);
        if (text.length <= max) return text;
    }
    return line([], all.length).slice(0, max - 2) + ']\n';
}
