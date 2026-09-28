/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { CANVAS_TOOL_DECLARATIONS, canvasHandlers } from '../src/node/gemini/tools/canvas-tools';
import {
    synthesizeQuestionCardFallback,
    synthesizeExecutionPlanFallback
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import type { ChatMessage, InteractiveQuestionCardData, ExecutionPlanCardData } from '../src/browser/generative-canvas/canvas-types';

describe('Cursor-Grade Interactive Confirmation & Clarification Card Architecture', () => {
    describe('1. Gemini Tool Declarations & Schemas', () => {
        it('registers ask_user_question with questions array, options, and recommended badges', () => {
            const decl = CANVAS_TOOL_DECLARATIONS.find(d => d.name === 'ask_user_question');
            expect(decl).toBeDefined();
            expect(decl?.description).toContain('clarifying question');
            expect(decl?.parameters?.properties?.questions).toBeDefined();
        });

        it('registers present_execution_plan with pipeline tiers, deliverables, and steps', () => {
            const decl = CANVAS_TOOL_DECLARATIONS.find(d => d.name === 'present_execution_plan');
            expect(decl).toBeDefined();
            expect(decl?.description).toContain('execution plan card');
            expect(decl?.parameters?.properties?.pipelineTier).toBeDefined();
            expect(decl?.parameters?.properties?.steps).toBeDefined();
        });
    });

    describe('2. Tool Handlers Execution', () => {
        it('executes ask_user_question and produces structured questionCard payload', () => {
            const result = canvasHandlers.ask_user_question({
                title: 'Select 3D Mesh Engine',
                questions: [
                    {
                        id: 'engine-choice',
                        prompt: 'Which 3D pipeline should be leveraged for this asset?',
                        allow_multiple: false,
                        options: [
                            { id: 'cpp-astra', label: 'C++20 Astra Engine', isRecommended: true, description: 'Fast native compilation' },
                            { id: 'comfy-gpu', label: 'Cloud Run L4 GPU', isRecommended: false, description: 'Neural diffusion mesh' }
                        ]
                    }
                ]
            }, {} as any);

            expect(result.resultPayload.status).toBe('pending_user_answer');
            const card = result.resultPayload.questionCard as InteractiveQuestionCardData;
            expect(card.title).toBe('Select 3D Mesh Engine');
            expect(card.questions.length).toBe(1);
            expect(card.questions[0].options[0].isRecommended).toBe(true);
            expect(card.questions[0].options[0].label).toBe('C++20 Astra Engine');
        });

        it('executes present_execution_plan and produces structured executionPlanCard payload', () => {
            const result = canvasHandlers.present_execution_plan({
                title: 'Mars Habitat 3D Scene Plan',
                goal: 'Synthesize procedural 3D Mars rover habitat environment',
                pipelineTier: 'tier1-native',
                deliverables: [
                    { canvasType: '3d-scene', assetFormat: '.glb', description: 'Watertight PBR Mars exploration scene' }
                ],
                steps: [
                    { id: 's1', title: 'Generate red terrain SDF', tier: 'tier1-native', engine: 'C++20 FastNoise3D' },
                    { id: 's2', title: 'Assemble solar array geometry', tier: 'tier1-native', engine: 'C++20 Astra Engine' }
                ],
                estimatedLatency: '~150ms'
            }, {} as any);

            expect(result.resultPayload.status).toBe('plan_presented');
            const plan = result.resultPayload.executionPlanCard as ExecutionPlanCardData;
            expect(plan.title).toBe('Mars Habitat 3D Scene Plan');
            expect(plan.pipelineTier).toBe('tier1-native');
            expect(plan.steps.length).toBe(2);
            expect(plan.confirmed).toBe(false);
            expect(plan.deliverables[0].canvasType).toBe('3d-scene');
        });
    });

    describe('3. Local Fallback Synthesizers for Ambiguity & Planning Mode', () => {
        it('synthesizes question card fallback when user asks for a 3D asset from an image without specifying format', () => {
            const prompt = 'Make a 3d plate of this object from the supplied image';
            const fallback = synthesizeQuestionCardFallback(prompt);

            expect(fallback.questionCard).toBeDefined();
            expect(fallback.questionCard?.title).toContain('3D');
            const q = fallback.questionCard?.questions[0];
            expect(q).toBeDefined();
            expect(q?.options.some(o => o.label.includes('C++20 Astra'))).toBe(true);
            expect(q?.options.some(o => o.label.includes('Gaussian Splat'))).toBe(true);
            expect(q?.options.some(o => o.label.includes('Cloud Run'))).toBe(true);
        });

        it('synthesizes execution plan fallback when user enters Planning Mode', () => {
            const prompt = 'Build a multi-track cyberpunk video sequence with green screen chroma keying and audio mix';
            const fallback = synthesizeExecutionPlanFallback(prompt);

            expect(fallback.executionPlanCard).toBeDefined();
            const plan = fallback.executionPlanCard!;
            expect(plan.goal).toBe(prompt);
            expect(plan.steps.length).toBeGreaterThanOrEqual(3);
            expect(plan.deliverables.length).toBeGreaterThanOrEqual(1);
            expect(plan.confirmed).toBe(false);
        });
    });

    describe('4. Protocol Contract Verification', () => {
        it('ChatMessage supports questionCard and executionPlanCard without runtime errors', () => {
            const message: ChatMessage = {
                id: 'test-msg-1',
                sender: 'assistant',
                text: 'Here is the plan for confirmation:',
                timestamp: '10:00 AM',
                executionPlanCard: {
                    title: 'Test Plan',
                    goal: 'Verify type contract',
                    pipelineTier: 'tier1-native',
                    deliverables: [{ canvasType: '3d-scene', description: 'Test 3D' }],
                    steps: [{ id: '1', title: 'Step 1' }]
                },
                questionCard: {
                    title: 'Test Questions',
                    questions: [
                        { id: 'q1', prompt: 'Select format', options: [{ id: 'o1', label: 'Option 1' }] }
                    ]
                }
            };

            expect(message.executionPlanCard?.pipelineTier).toBe('tier1-native');
            expect(message.questionCard?.questions[0].options[0].label).toBe('Option 1');
        });
    });
});
