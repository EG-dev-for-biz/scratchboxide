import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, describeVisualProblems, parseReviewReply, renderReviewViews, reviewModelVisually } from '../src/node/3d-engine/visual-review';
import { decodePng } from '../src/node/texture-processing';
import type { TriangleSoup } from '../src/node/3d-engine/part-connectivity';

// A unit cube is enough to exercise rendering; the model's judgement is checked live, not here.
const cube: TriangleSoup = (() => {
    const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, -0.5, 1, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5];
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    return { positions: Float32Array.from(v), indices: Uint32Array.from(f) };
})();

describe('visual review', () => {
    it('renders three PNG views and sends them with the user request', async () => {
        let seenPrompt = '';
        let seenImages: Buffer[] = [];
        const { result, views } = await reviewModelVisually(cube, 'a simple wooden stool', 'stool', async (prompt, images) => {
            seenPrompt = prompt;
            seenImages = images;
            return '{"verdict":"ok"}';
        });
        expect(result.verdict).toBe('ok');
        expect(views.map(v => v.label)).toEqual(['three-quarter view', 'side view', 'top view']);
        expect(seenImages).toHaveLength(3);
        for (const png of seenImages) expect(png.subarray(1, 4).toString()).toBe('PNG');
        expect(seenPrompt).toContain('a simple wooden stool');
        expect(seenPrompt).toContain('three-quarter view, side view, top view');
    });

    it('keeps high-confidence problems and drops low-confidence ones', () => {
        const reply = 'Here you go: {"verdict":"problems","problems":[' +
            '{"view":"top view","problem":"One leg sticks out beyond the seat.","confidence":"high"},' +
            '{"view":"side view","problem":"Legs look off-centre.","confidence":"low"}]}';
        const result = parseReviewReply(reply);
        expect(result.verdict).toBe('problems');
        expect(result.problems).toEqual([{ view: 'top view', problem: 'One leg sticks out beyond the seat.' }]);
        expect(describeVisualProblems(result)).toContain('top view: One leg sticks out beyond the seat.');
    });

    it('treats only-low-confidence findings as ok, and unparseable replies as skipped', () => {
        expect(parseReviewReply('{"verdict":"problems","problems":[{"problem":"maybe tilted","confidence":"low"}]}').verdict).toBe('ok');
        expect(parseReviewReply('Looks fine to me.').verdict).toBe('skipped');
        expect(describeVisualProblems({ verdict: 'ok', problems: [] })).toBeUndefined();
    });

    it('reports a failed vision call as skipped instead of throwing', async () => {
        const { result } = await reviewModelVisually(cube, 'a stool', '', async () => { throw new Error('quota exceeded'); });
        expect(result.verdict).toBe('skipped');
        expect(result.reason).toContain('quota exceeded');
    });

    it('asks only for objective shape errors', () => {
        const prompt = buildReviewPrompt('a chair', '', ['side view']);
        expect(prompt).toMatch(/Do not comment on colour, material/);
        expect(prompt).toMatch(/JSON only/);
    });
});

describe('visual review of a large scene', () => {
    it('draws a model more than a kilometre across (the camera stands off past the default far plane)', () => {
        // the unit cube scaled to 1.2 km: the review camera stands about 3 km away
        const big: TriangleSoup = { positions: cube.positions.map(v => v * 1200), indices: cube.indices };
        const [view] = renderReviewViews(big, 128);
        const { data } = decodePng(view.png);
        let drawn = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] !== 236 || data[i + 1] !== 238 || data[i + 2] !== 242) drawn++;
        expect(drawn).toBeGreaterThan(128 * 128 * 0.1);
    });
});
