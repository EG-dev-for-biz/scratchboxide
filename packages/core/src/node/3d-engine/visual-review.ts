/**
 * Visual self-review for generated models: render a few clay views in software and ask a vision model
 * whether the shape matches the request. Catches what the structure check cannot, such as crooked or
 * crossing legs, missing parts, wrong counts or proportions.
 */
import { HeadlessMeshSilhouetteRenderer } from '../spatial/HeadlessMeshSilhouetteRenderer';
import type { TriangleSoup } from './part-connectivity';

export interface ReviewView {
    label: string;
    png: Buffer;
}

export interface VisualReviewProblem {
    view?: string;
    problem: string;
}

export interface VisualReviewResult {
    verdict: 'ok' | 'problems' | 'skipped';
    problems: VisualReviewProblem[];
    reason?: string;
}

/** Sends a prompt plus PNG images to a vision model and returns its text reply. */
export type VisionModelCall = (prompt: string, images: Buffer[]) => Promise<string>;

const VIEWS: Array<{ label: string; azimuthDeg: number; elevationDeg: number }> = [
    { label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 },
    { label: 'side view', azimuthDeg: 90, elevationDeg: 4 },
    { label: 'top view', azimuthDeg: 20, elevationDeg: 72 }
];

export function renderReviewViews(soup: TriangleSoup, size = 512): ReviewView[] {
    const p = soup.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    }
    const center = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
    const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = 40;
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;

    return VIEWS.map(view => {
        const az = (view.azimuthDeg * Math.PI) / 180, el = (view.elevationDeg * Math.PI) / 180;
        const pose = {
            x: center[0] + distance * Math.cos(el) * Math.sin(az),
            y: center[1] + distance * Math.sin(el),
            z: center[2] + distance * Math.cos(el) * Math.cos(az),
            targetX: center[0], targetY: center[1], targetZ: center[2],
            fov
        };
        const { width, height, rgba } = HeadlessMeshSilhouetteRenderer.renderShadedMesh(
            { vertices: soup.positions, indices: soup.indices }, pose, size, size,
            { clayColor: [196, 200, 206], bgColor: [236, 238, 242, 255], lightDir: [0.45, 0.85, 0.35], clipNearPlane: true }
        );
        return { label: view.label, png: HeadlessMeshSilhouetteRenderer.encodePng(width, height, rgba) };
    });
}

export function buildReviewPrompt(request: string, description: string, labels: string[]): string {
    return [
        'You are checking a procedurally generated 3D model against what the user asked for.',
        `User request: "${request}"`,
        description ? `What the script says it built: "${description}"` : '',
        `The images are untextured clay renders, in this order: ${labels.join(', ')}.`,
        'Report only clear, objective shape or structure errors that are visible in the images: parts that are missing, ' +
        'detached or floating, members that cross or lean the wrong way, wrong counts (for example 3 legs instead of 4), ' +
        'clearly wrong proportions, or broken, collapsed or inside-out geometry. Do not comment on colour, material, ' +
        'lighting, level of detail or style, and do not suggest improvements.',
        'Perspective can make symmetric parts look offset in a single view. Mark a problem "high" confidence only if it is ' +
        'unmistakable and consistent across at least two views; otherwise mark it "low". If you are unsure, reply ok.',
        'Reply with JSON only, no prose: {"verdict":"ok"} or {"verdict":"problems","problems":[{"view":"<view>","problem":"<one sentence>","confidence":"high|low"}]}.'
    ].filter(Boolean).join('\n');
}

export function parseReviewReply(text: string): VisualReviewResult {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { verdict: 'skipped', problems: [], reason: 'review reply was not JSON' };
    try {
        const json = JSON.parse(text.slice(start, end + 1));
        // Low-confidence findings are dropped: a misread view would send the model into a needless rebuild.
        const problems: VisualReviewProblem[] = Array.isArray(json.problems)
            ? json.problems
                .filter((x: any) => x && typeof x.problem === 'string' && x.confidence !== 'low')
                .map((x: any) => ({ view: typeof x.view === 'string' ? x.view : undefined, problem: x.problem }))
            : [];
        if (json.verdict === 'problems' && problems.length) return { verdict: 'problems', problems };
        return { verdict: 'ok', problems: [] };
    } catch {
        return { verdict: 'skipped', problems: [], reason: 'review reply was not valid JSON' };
    }
}

export async function reviewModelVisually(
    soup: TriangleSoup,
    request: string,
    description: string,
    callVisionModel: VisionModelCall
): Promise<{ result: VisualReviewResult; views: ReviewView[] }> {
    const views = renderReviewViews(soup);
    try {
        const reply = await callVisionModel(buildReviewPrompt(request, description, views.map(v => v.label)), views.map(v => v.png));
        return { result: parseReviewReply(reply), views };
    } catch (err: any) {
        return { result: { verdict: 'skipped', problems: [], reason: `vision model call failed: ${err?.message || err}` }, views };
    }
}

/** Instruction for the model when the review found problems; undefined otherwise. */
export function describeVisualProblems(result: VisualReviewResult): string | undefined {
    if (result.verdict !== 'problems') return undefined;
    const list = result.problems.slice(0, 6).map(p => (p.view ? `${p.view}: ` : '') + p.problem).join('; ');
    return `Visual review of clay renders found shape problems: ${list}. Check each against the coordinates in your script; ` +
        'if the script confirms it, fix the script and run execute_3d_python_script again. If your numbers show the review misread ' +
        'the images (for example symmetric parts that only look offset in perspective), do not change the model.';
}
