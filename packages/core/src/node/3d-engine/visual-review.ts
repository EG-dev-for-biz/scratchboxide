/**
 * Visual self-review for generated models: render a few clay views in software and ask a vision model
 * whether the shape matches the request. Catches what the structure check cannot, such as crooked or
 * crossing legs, missing parts, wrong counts or proportions.
 */
import { HeadlessMeshSilhouetteRenderer } from '../spatial/HeadlessMeshSilhouetteRenderer';
import type { TriangleSoup } from './part-connectivity';
import { GeminiClient } from '../gemini/gemini-client';
import { decodePng } from '../texture-processing';
import { verticalFovDeg, type ShotCamera } from '../../common/spatial/shot-detail-budget';

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

let visionClient: GeminiClient | undefined;
/** Sends a prompt and PNG renders to Gemini; uses the chat's model so the review runs on known credentials. */
export async function callVisionModel(prompt: string, images: Buffer[], model?: string): Promise<string> {
    visionClient ??= new GeminiClient();
    const { text } = await visionClient.generateContent({
        model: model || 'gemini-3.7-flash',
        prompt,
        inlineData: images.map(png => ({ mimeType: 'image/png', data: png.toString('base64') })),
        temperature: 0,
        maxOutputTokens: 4096
    });
    return text;
}

const VIEWS: Array<{ label: string; azimuthDeg: number; elevationDeg: number }> = [
    { label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 },
    { label: 'side view', azimuthDeg: 90, elevationDeg: 4 },
    { label: 'top view', azimuthDeg: 20, elevationDeg: 72 }
];

export function renderReviewViews(soup: TriangleSoup, size = 512, options: { useMaterialColors?: boolean; views?: typeof VIEWS } = {}): ReviewView[] {
    const p = soup.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    }
    const center = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
    const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = 40;
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;

    return (options.views || VIEWS).map(view => {
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
            {
                clayColor: [196, 200, 206], bgColor: [236, 238, 242, 255], lightDir: [0.45, 0.85, 0.35], clipNearPlane: true,
                // the camera stands off by the model's own size, so a scene over a kilometre across is still inside the far plane
                farPlane: Math.max(1000, distance + radius * 1.1),
                vertexColors: options.useMaterialColors ? soup.colors : undefined
            }
        );
        return { label: view.label, png: HeadlessMeshSilhouetteRenderer.encodePng(width, height, rgba) };
    });
}

/** The label a shot's view carries in the review (buildReviewPrompt explains it by this prefix). */
export const SHOT_VIEW_LABEL = 'shot camera';
/** How far the shot view draws, in metres: a street shot looks to the horizon. */
const SHOT_VIEW_FAR_M = 20000;

/**
 * The model as its declared shot frames it (sb.shot): the picture the scene is built for, in clay, at the shot's
 * own aspect. The review's other views fit the whole model; this one shows what the lens actually sees.
 */
export function renderShotView(soup: TriangleSoup, shot: ShotCamera, width = 896): ReviewView {
    const height = Math.max(2, Math.round(width / shot.aspect));
    const pose = {
        x: shot.position[0], y: shot.position[1], z: shot.position[2],
        targetX: shot.target[0], targetY: shot.target[1], targetZ: shot.target[2],
        fov: verticalFovDeg(shot)
    };
    const { rgba } = HeadlessMeshSilhouetteRenderer.renderShadedMesh(
        { vertices: soup.positions, indices: soup.indices }, pose, width, height,
        { clayColor: [196, 200, 206], bgColor: [236, 238, 242, 255], lightDir: [0.45, 0.85, 0.35], clipNearPlane: true, farPlane: SHOT_VIEW_FAR_M }
    );
    return { label: `${SHOT_VIEW_LABEL} "${shot.name}"`, png: HeadlessMeshSilhouetteRenderer.encodePng(width, height, rgba) };
}

export function buildReviewPrompt(request: string, description: string, labels: string[]): string {
    return [
        'You are checking a procedurally generated 3D model against what the user asked for.',
        `User request: "${request}"`,
        description ? `What the script says it built: "${description}"` : '',
        `The images are untextured clay renders, in this order: ${labels.join(', ')}.`,
        labels.some(l => l.startsWith(SHOT_VIEW_LABEL))
            ? `A view labelled "${SHOT_VIEW_LABEL}" is the camera the scene is built for: also report what is wrong in that frame ` +
              'itself (the subject cut off or out of frame, the frame mostly empty or blocked by something close to the lens, ' +
              'the camera inside or under geometry, or something the request places on one side of the frame, left or right, ' +
              'near or far, standing on the other). The other views fit the whole model and are there to check its shape.'
            : '',
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
    callVisionModel: VisionModelCall,
    shotViews: ReviewView[] = []
): Promise<{ result: VisualReviewResult; views: ReviewView[] }> {
    const views = [...shotViews, ...renderReviewViews(soup)];
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

const AUDIT_VIEWS: Array<{ label: string; azimuthDeg: number; elevationDeg: number }> = [
    { label: 'three-quarter view', azimuthDeg: 35, elevationDeg: 22 },
    { label: 'front view', azimuthDeg: 0, elevationDeg: 5 },
    { label: 'side view', azimuthDeg: 90, elevationDeg: 5 },
    { label: 'top view', azimuthDeg: 20, elevationDeg: 72 }
];

/** Grid positions of tiled views, in tile order. */
const GRID_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Tiles up to four equal-size view renders into one 2x2 PNG (row-major), so a vision check sends one image instead
 * of four; empty cells stay white.
 */
export function tileViews2x2(views: ReviewView[]): Buffer {
    const tiles = views.slice(0, 4).map(v => decodePng(v.png));
    const tw = tiles[0].width, th = tiles[0].height;
    const out = Buffer.alloc(tw * 2 * th * 2 * 4, 255);
    tiles.forEach((t, i) => {
        const ox = (i % 2) * tw, oy = Math.floor(i / 2) * th;
        for (let y = 0; y < Math.min(th, t.height); y++) {
            t.rgba.copy(out, ((oy + y) * tw * 2 + ox) * 4, y * t.width * 4, (y * t.width + Math.min(tw, t.width)) * 4);
        }
    });
    return HeadlessMeshSilhouetteRenderer.encodePng(tw * 2, th * 2, out);
}

export function buildAuditPrompt(request: string, labels: string[], tiled = false): string {
    const layout = tiled
        ? `The image is a 2x2 grid of software renders of the actual model file with its real material colors and simple lighting: ${labels.map((l, i) => `${GRID_POSITIONS[i]} ${l}`).join(', ')}. Surface textures are not shown.`
        : `The images are software renders of the actual model file with its real material colors and simple lighting, in this order: ${labels.join(', ')}. Surface textures are not shown.`;
    return [
        'You are auditing a finished 3D model against what the user asked for. Judge only what is visible in the images.',
        `User request: "${request}"`,
        layout,
        'Check every requirement in the request: each named part is present, counts are right, parts are attached and oriented correctly, ' +
        'proportions are plausible, and the colors match any color, material or finish the user asked for (for example "grey clay", "brass", "white").',
        'Perspective can make symmetric parts look offset in one view. Mark a problem "high" confidence only if it is unmistakable; otherwise "low".',
        'Reply with JSON only: {"verdict":"ok","checked":["<requirement you confirmed>", ...]} or ' +
        '{"verdict":"problems","checked":[...],"problems":[{"view":"<view>","problem":"<one sentence>","confidence":"high|low"}]}.'
    ].join('\n');
}

/**
 * Audit a finished model against the request from real renders of its file, colors included. The
 * result is whatever the vision model found in those pixels; no score is invented.
 */
export async function auditModelAgainstRequest(
    soup: TriangleSoup,
    request: string,
    callVisionModel: VisionModelCall
): Promise<{ result: VisualReviewResult & { checked: string[] }; views: ReviewView[] }> {
    const views = renderReviewViews(soup, 512, { useMaterialColors: true, views: AUDIT_VIEWS });
    try {
        // The four 512 px views go as one 1024 px 2x2 image: one upload, the same pixels.
        const reply = await callVisionModel(buildAuditPrompt(request, views.map(v => v.label), true), [tileViews2x2(views)]);
        const parsed = parseReviewReply(reply);
        let checked: string[] = [];
        try {
            const json = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
            if (Array.isArray(json.checked)) checked = json.checked.filter((c: unknown) => typeof c === 'string');
        } catch { /* parseReviewReply already reported the reply as unusable */ }
        return { result: { ...parsed, checked }, views };
    } catch (err: any) {
        return { result: { verdict: 'skipped', problems: [], checked: [], reason: `vision model call failed: ${err?.message || err}` }, views };
    }
}
