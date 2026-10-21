import { test } from 'vitest';
import * as assert from 'assert';
import { morphArtifact, morphKanbanToNodeGraph, morphNodeGraphToKanban } from '../src/browser/generative-canvas/primitive-transformer-engine';
import type { CanvasArtifact, KanbanBoardData, NodeGraphData } from '../src/browser/generative-canvas/canvas-types';

function sampleBoard(): KanbanBoardData {
    return {
        title: 'Sprint Roadmap',
        columns: [
            {
                id: 'col-todo',
                title: 'To Do',
                color: 'blue',
                cards: [
                    { id: 'card-1', title: 'Stripe Webhooks', description: 'Reconciliation pipe', tag: 'Backend', tagColor: 'indigo', priority: 'medium' },
                    { id: 'card-2', title: 'Org Switcher', description: 'Tenancy isolation', tag: 'Core', tagColor: 'purple', priority: 'low' }
                ]
            },
            {
                id: 'col-done',
                title: 'Done',
                color: 'emerald',
                cards: [
                    { id: 'card-3', title: 'Auth Backend', description: 'REST pipe', tag: 'AI Core', tagColor: 'emerald', priority: 'high' }
                ]
            }
        ]
    };
}

test('morphKanbanToNodeGraph: real per-card decomposition, not a placeholder column count', () => {
    const board = sampleBoard();
    const graph = morphKanbanToNodeGraph(board);

    const cardNodes = graph.nodes.filter(n => n.id.startsWith('card-'));
    assert.strictEqual(cardNodes.length, 3, 'should have one node per real card');
    const colNodes = graph.nodes.filter(n => n.id.startsWith('col-'));
    assert.strictEqual(colNodes.length, 2, 'should have one scaffold node per column');

    const card1Node = graph.nodes.find(n => n.id === 'card-card-1');
    assert.ok(card1Node);
    assert.strictEqual(card1Node!.parameters?.title, 'Stripe Webhooks', 'node should carry the real card title, not a fabricated one');
    assert.strictEqual(graph.sourceArtifact?.type, 'kanban-board');
});

test('morphKanbanToNodeGraph: an empty board produces zero real card nodes, not fake placeholders', () => {
    const board: KanbanBoardData = { title: 'Empty Board', columns: [{ id: 'col-todo', title: 'To Do', cards: [] }] };
    const graph = morphKanbanToNodeGraph(board);
    const cardNodes = graph.nodes.filter(n => n.id.startsWith('card-'));
    assert.strictEqual(cardNodes.length, 0, 'empty board should yield zero card nodes, never fabricated ones');
});

test('morphNodeGraphToKanban write-back: editing a node updates the real card, leaves others untouched', () => {
    const board = sampleBoard();
    const graph = morphKanbanToNodeGraph(board);

    const targetNode = graph.nodes.find(n => n.id === 'card-card-1')!;
    targetNode.parameters = { ...targetNode.parameters, title: 'Stripe Webhooks (Refactored)', priority: 'urgent' };

    const regenerated = morphNodeGraphToKanban(graph); // no explicit baseBoard — must recover via sourceArtifact

    const col = regenerated.columns.find(c => c.id === 'col-todo')!;
    const updatedCard = col.cards.find(c => c.id === 'card-1')!;
    assert.strictEqual(updatedCard.title, 'Stripe Webhooks (Refactored)');
    assert.strictEqual(updatedCard.priority, 'urgent');

    const untouchedCard = col.cards.find(c => c.id === 'card-2')!;
    assert.strictEqual(untouchedCard.title, 'Org Switcher', 'editing one card should not perturb another');
    assert.strictEqual(untouchedCard.description, 'Tenancy isolation');
});

test('morphArtifact round-trip: kanban-board -> node-graph -> kanban-board carries the base board automatically', () => {
    const board = sampleBoard();
    const boardArtifact: CanvasArtifact = { id: 'art-board-1', type: 'kanban-board', title: board.title, summary: '', data: board, createdAt: new Date().toISOString(), version: 1 };

    const graphArtifact = morphArtifact(boardArtifact, 'node-graph');
    const graphData = graphArtifact.data as NodeGraphData;
    const node = graphData.nodes.find(n => n.id === 'card-card-3')!;
    node.parameters = { ...node.parameters, description: 'Rewritten via node graph' };

    const boardBackArtifact = morphArtifact(graphArtifact, 'kanban-board');
    const boardBack = boardBackArtifact.data as KanbanBoardData;
    const updatedCard = boardBack.columns.find(c => c.id === 'col-done')!.cards.find(c => c.id === 'card-3')!;
    assert.strictEqual(updatedCard.description, 'Rewritten via node graph');
});
