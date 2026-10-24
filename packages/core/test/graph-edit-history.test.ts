import { describe, expect, it } from 'vitest';
import { emptyGraphHistory, GRAPH_HISTORY_LIMIT, recordGraphEdit, redoGraphEdit, undoGraphEdit } from '../src/browser/generative-canvas/graph-edit-history';
import type { NodeGraphData } from '../src/browser/generative-canvas/canvas-types';

const node = (id: string, x = 0, extra: object = {}) => ({ id, label: id, x, y: 0, ...extra });
const g = (nodes: any[], edges: any[] = []): NodeGraphData => ({ title: 't', nodes, edges });
const edge = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

describe('node graph undo / redo', () => {
    it('undoes and redoes a delete, a connect, an unlink and a move, in order', () => {
        const a0 = g([node('a'), node('b')]);
        const a1 = g([node('a'), node('b')], [edge('a', 'b')]); // connect
        const a2 = g([node('a', 300), node('b')], [edge('a', 'b')]); // move
        const a3 = g([node('a', 300), node('b')], []); // unlink
        const a4 = g([node('a', 300)], []); // delete b
        let h = emptyGraphHistory();
        h = recordGraphEdit(h, a0, a1, undefined, 0);
        h = recordGraphEdit(h, a1, a2, undefined, 10_000);
        h = recordGraphEdit(h, a2, a3, undefined, 20_000);
        h = recordGraphEdit(h, a3, a4, undefined, 30_000);
        let cur = a4;
        const seen: NodeGraphData[] = [];
        for (let i = 0; i < 4; i++) { const s = undoGraphEdit(h, cur)!; h = s.history; cur = s.graph; seen.push(cur); }
        expect(seen.map(x => [x.nodes.map(n => `${n.id}@${n.x}`).join(','), x.edges.length])).toEqual([
            ['a@300,b@0', 0], ['a@300,b@0', 1], ['a@0,b@0', 1], ['a@0,b@0', 0]
        ]);
        expect(undoGraphEdit(h, cur)).toBeUndefined();
        for (let i = 0; i < 4; i++) { const s = redoGraphEdit(h, cur)!; h = s.history; cur = s.graph; }
        expect(cur.nodes.map(n => n.id)).toEqual(['a']);
        expect(redoGraphEdit(h, cur)).toBeUndefined();
    });

    it('a new edit after an undo drops the redo steps; an edit that changes nothing is not a step', () => {
        const a0 = g([node('a')]), a1 = g([node('a', 5)]), a2 = g([node('a', 9)]);
        let h = recordGraphEdit(emptyGraphHistory(), a0, a1, undefined, 0);
        h = undoGraphEdit(h, a1)!.history;
        expect(h.future).toHaveLength(1);
        h = recordGraphEdit(h, a0, a2, undefined, 5000);
        expect(h.future).toHaveLength(0);
        expect(recordGraphEdit(h, a2, g([node('a', 9, { status: 'running' })]), undefined, 9000)).toBe(h);
    });

    it('keeps the run state nodes have now: undoing a move does not bring back an old error', () => {
        const before = g([node('t', 0, { status: 'error', errorMessage: 'old failure' })]);
        const moved = g([node('t', 200, { status: 'error', errorMessage: 'old failure' })]);
        const h = recordGraphEdit(emptyGraphHistory(), before, moved, undefined, 0);
        const ranSince = g([node('t', 200, { status: 'completed', outputData: { triangles: 310 } })]);
        const back = undoGraphEdit(h, ranSince)!.graph.nodes[0];
        expect(back).toMatchObject({ x: 0, status: 'completed', outputData: { triangles: 310 } });
        expect(back.errorMessage).toBeUndefined();
    });

    it('typing into one field is one step; a different field or a pause starts a new one', () => {
        let h = emptyGraphHistory();
        const v = (label: string) => g([{ ...node('a'), label }]);
        h = recordGraphEdit(h, v(''), v('M'), 'node:a:label', 0);
        h = recordGraphEdit(h, v('M'), v('Me'), 'node:a:label', 300);
        h = recordGraphEdit(h, v('Me'), v('Mes'), 'node:a:label', 600);
        expect(h.past).toHaveLength(1);
        expect(undoGraphEdit(h, v('Mes'))!.graph.nodes[0].label).toBe('');
        h = recordGraphEdit(h, v('Mes'), v('Mesh'), 'node:a:label', 5000);
        expect(h.past).toHaveLength(2);
    });

    it('keeps at most the last steps', () => {
        let h = emptyGraphHistory();
        for (let i = 0; i < GRAPH_HISTORY_LIMIT + 20; i++) h = recordGraphEdit(h, g([node('a', i)]), g([node('a', i + 1)]), undefined, i * 10_000);
        expect(h.past).toHaveLength(GRAPH_HISTORY_LIMIT);
        expect(h.past[0].nodes[0].x).toBe(20);
    });
});
