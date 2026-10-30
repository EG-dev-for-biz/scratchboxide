/**
 * Product scope: which kinds of canvas this build lets people make. A temporary gate while the app is developed as a
 * 3D and VFX tool: with SCRATCHBOX_PRODUCT_SCOPE=3d-vfx the model and the UI make only 3D scenes and video timelines,
 * and the canvases those open beside them (a scene's node graph, a studio's browser page) still show. Unset, every
 * canvas type is available, as before.
 *
 * The gate reads canvas types only, never words in a prompt (AGENTS.md §1.2). It hides; it deletes nothing: artifacts
 * of other types already saved in a session stay on disk and come back when the gate is off.
 */
import type { PrimitiveType, StudioLayoutMode } from '../browser/generative-canvas/canvas-types';

export type ProductScope = 'all' | '3d-vfx';

/** The canvas types people (and the model) can start in the 3D/VFX build. */
export const SCOPED_PROJECT_TYPES: readonly PrimitiveType[] = ['3d-scene', 'video-timeline'];

/** Canvas types the 3D/VFX build shows but never offers to create: the app opens them beside a project. */
export const SCOPED_COMPANION_TYPES: readonly PrimitiveType[] = ['node-graph', 'interactive-browser', 'browser'];

/** The layout modes those types open in (chat always stays). */
const SCOPED_LAYOUT_MODES: readonly StudioLayoutMode[] = ['chat', '3d', 'video', 'automation', 'browser'];

/** The layout modes a new workspace file can start in: chat and the project types' own. */
const SCOPED_CREATE_MODES: readonly StudioLayoutMode[] = ['chat', '3d', 'video'];

function readScopeSetting(): string | undefined {
    try {
        // On the server this is the process environment at call time; in the browser bundle Vite replaces the whole
        // expression with the value the app was started with (desktop-app/vite.config.ts `define`).
        return process.env.SCRATCHBOX_PRODUCT_SCOPE;
    } catch {
        // A bundle built without the define has no `process`: the gate is off.
        return undefined;
    }
}

/** The scope this process runs in: '3d-vfx' when SCRATCHBOX_PRODUCT_SCOPE says so, else 'all'. */
export function productScope(): ProductScope {
    return readScopeSetting()?.trim().toLowerCase() === '3d-vfx' ? '3d-vfx' : 'all';
}

export function isScopedTo3dVfx(scope: ProductScope = productScope()): boolean {
    return scope === '3d-vfx';
}

/** Whether a canvas of this type may be created (by a person or the model). */
export function canCreatePrimitive(type: string, scope: ProductScope = productScope()): boolean {
    return scope === 'all' || (SCOPED_PROJECT_TYPES as readonly string[]).includes(type);
}

/** Whether a canvas of this type is shown: a project type or a companion one. */
export function canShowPrimitive(type: string, scope: ProductScope = productScope()): boolean {
    return canCreatePrimitive(type, scope) || (SCOPED_COMPANION_TYPES as readonly string[]).includes(type);
}

/** Whether a layout mode is offered. */
export function canShowLayoutMode(mode: string, scope: ProductScope = productScope()): boolean {
    return scope === 'all' || (SCOPED_LAYOUT_MODES as readonly string[]).includes(mode);
}

/** Whether a new workspace file may start in this layout mode. */
export function canCreateInLayoutMode(mode: string, scope: ProductScope = productScope()): boolean {
    return scope === 'all' || (SCOPED_CREATE_MODES as readonly string[]).includes(mode);
}

/**
 * Why a canvas of this type cannot be created in this build, in words for the model and the person; undefined when
 * it can.
 */
export function primitiveOutOfScopeReason(type: string, scope: ProductScope = productScope()): string | undefined {
    if (canCreatePrimitive(type, scope)) return undefined;
    return `This build of Scratchbox is limited to 3D and VFX projects: it makes ${SCOPED_PROJECT_TYPES.join(' and ')} canvases only, so no ${type} was created.`;
}
