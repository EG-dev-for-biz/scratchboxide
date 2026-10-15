/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A 3D scene asked for from words that no template fits is not built: synthesizeContextual3DScene fails with
 * NoSceneBuiltError instead of returning an empty scene titled after the prompt, a document that fits no template does
 * not morph into a 3D scene, and the canvas stage says why the morph failed instead of opening anything.
 */

import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bento = vi.hoisted(() => ({ props: undefined as any }));
vi.mock('../src/browser/generative-canvas/BentoStageLayout', () => ({
    BentoStageLayout: (props: any) => {
        bento.props = props;
        return null;
    }
}));

import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { NoSceneBuiltError } from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import { morphArtifact } from '../src/browser/generative-canvas/primitive-transformer-engine';
import { CanvasCardBody } from '../src/browser/generative-canvas/studio/CanvasCardBody';
import type { CanvasArtifact } from '../src/browser/generative-canvas/canvas-types';

const MINUTES: CanvasArtifact = {
    id: 'doc-minutes',
    type: 'markdown-document',
    title: 'Meeting minutes',
    version: 1,
    createdAt: '09:00',
    data: {
        title: 'Meeting minutes',
        sections: [{ id: 's1', type: 'text', content: 'Attendees agreed on the agenda and the next date.' }]
    }
} as unknown as CanvasArtifact;

function thrown(fn: () => unknown): any {
    try {
        fn();
    } catch (err) {
        return err;
    }
    return undefined;
}

describe('no scene stands in for one nothing built', () => {
    it('fails a prompt no template fits with NoSceneBuiltError, naming the request and the tools that build', () => {
        const error = thrown(() => synthesizeContextual3DScene('Meeting minutes'));
        expect(error).toBeInstanceOf(NoSceneBuiltError);
        expect(error.code).toBe('NO_SCENE_BUILT');
        expect(error.message).toContain('No 3D scene was built for "Meeting minutes"');
        expect(error.message).toContain('build_3d_object_from_reference');
        expect(error.message).toContain('execute_3d_python_script');
        expect(error.message).toContain('google_3d_tiles_get_clay');
    });

    it('still builds the demo session\'s glass scene, which the studio synthesizes when it loads', () => {
        expect(synthesizeContextual3DScene('build me a scene of a bully going through a plate of glass').sceneType).toBe('glass_shatter');
    });

    it('does not morph a document no template fits into a 3D scene', () => {
        expect(thrown(() => morphArtifact(MINUTES, '3d-scene'))).toBeInstanceOf(NoSceneBuiltError);
    });

    it('shows why a morph failed on the stage, and opens nothing', () => {
        const showToast = vi.fn();
        const handleMorphArtifact = vi.fn();
        renderToStaticMarkup(React.createElement(CanvasCardBody, {
            activeArtifact: MINUTES,
            setActiveArtifact: () => undefined,
            artifactHistory: [MINUTES],
            activeWorkspace: { id: 'w', name: 'w', path: '/tmp/w' },
            layoutMode: 'document',
            stageLayoutMode: 'dual-split-horizontal',
            setStageLayoutMode: () => undefined,
            handleUpdateArtifact: () => undefined,
            handleMorphArtifact,
            handleOpenInAppBrowser: () => undefined,
            handleSurfaceAiPrompt: () => undefined,
            showToast
        } as any));
        expect(bento.props?.onMorphArtifact).toBeTypeOf('function');

        bento.props.onMorphArtifact(MINUTES, '3d-scene');
        expect(handleMorphArtifact).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][0]).toContain('Could not turn "Meeting minutes" into a 3d-scene: No 3D scene was built for "Meeting minutes"');

        // A morph that can be made still opens.
        bento.props.onMorphArtifact(MINUTES, 'kanban-board');
        expect(handleMorphArtifact).toHaveBeenCalledTimes(1);
        expect(handleMorphArtifact.mock.calls[0][0].type).toBe('kanban-board');
    });
});
