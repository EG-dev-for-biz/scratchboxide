/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { LensContext, LensSourceContent, LensSyncMode } from '../lens-bridge';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { NoActiveBrowserPageError } from '../../browser-proxy-service';

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

// ============================================================================
// Lens Tools
// ============================================================================

export const LENS_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'lens_project',
        description: 'Project disk files or codebase paths into an interactive visual primitive canvas artifact with bidirectional synchronization.',
        parameters: {
            type: 'OBJECT',
            properties: {
                filePath: { type: 'STRING', description: 'The primary disk file or workspace directory path to project (e.g. docs/spec.md, src/App.tsx, ROADMAP.md, workflows/deploy.workflow.json, scenes/world.scene.json, analytics.csv, session.browser.json)' },
                options: {
                    type: 'OBJECT',
                    description: 'Optional projection options including syncMode, targetSubdirectory, and context metadata'
                }
            },
            required: ['filePath']
        }
    },
    {
        name: 'lens_unproject',
        description: 'Unproject modified visual canvas primitive data back into exact, AST/syntax-preserving disk files.',
        parameters: {
            type: 'OBJECT',
            properties: {
                artifactId: { type: 'STRING', description: 'The unique artifact ID to unproject back to disk files' },
                diskContent: { type: 'STRING', description: 'Optional baseline disk content string or file map JSON' }
            },
            required: ['artifactId']
        }
    },
    {
        name: 'lens_list_bindings',
        description: 'List all active file-to-artifact codebase lens bindings and their live synchronization statuses (synced, dirty-ui, dirty-disk).',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'lens_sync',
        description: 'Force bidirectional synchronization between disk files and the visual primitive canvas artifact in either direction.',
        parameters: {
            type: 'OBJECT',
            properties: {
                artifactId: { type: 'STRING', description: 'The unique artifact ID of the binding to synchronize' },
                direction: { type: 'STRING', description: 'Synchronization direction: "in" (disk -> visual UI) or "out" (visual UI -> disk)' }
            },
            required: ['artifactId', 'direction']
        }
    }
];

export const asLensSource = (value: unknown): LensSourceContent | undefined => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value as Record<string, string>;
    return undefined;
};

export const lensHandlers: Record<string, ToolHandler> = {
    async lens_project(args, ctx) {
        const filePath = asString(args.filePath);
        const options = (args.options && typeof args.options === 'object')
            ? args.options as { artifactId?: string; syncMode?: LensSyncMode; context?: LensContext }
            : undefined;
        const res = await ctx.lens.executeLensProject(filePath, asLensSource(args.sourceContent), options);
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Projected ${filePath} into canvas.` : (res.error || 'Projection failed')
        };
    },

    async lens_unproject(args, ctx) {
        const artifactId = asString(args.artifactId);
        const res = await ctx.lens.executeLensUnproject(
            artifactId,
            args.primitiveData,
            asLensSource(args.currentDiskContent),
            args.context as LensContext | undefined
        );
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Unprojected ${artifactId} to disk.` : (res.error || 'Unproject failed')
        };
    },

    lens_list_bindings(_args, ctx) {
        const bindings = ctx.lens.executeLensListBindings();
        return {
            resultPayload: { success: true, bindings },
            summaryResult: `Found ${bindings.length} active lens bindings.`
        };
    },

    lens_sync(args, ctx) {
        const artifactId = asString(args.artifactId);
        const direction = args.direction === 'out' ? 'out' : 'in';
        const res = ctx.lens.executeLensSync(
            artifactId,
            direction,
            { diskContent: asLensSource(args.diskContent), primitiveData: args.primitiveData },
            args.context as LensContext | undefined
        );
        return {
            resultPayload: res as unknown as ToolResultPayload,
            status: res.success ? 'completed' : 'failed',
            summaryResult: res.success ? `Synced ${artifactId} (${direction}).` : (res.error || 'Sync failed')
        };
    }
};

// ============================================================================
// Browser Tools
// ============================================================================

export const BROWSER_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'browser_navigate',
        description: 'Navigate the active canvas web browser to a specified URL.',
        parameters: {
            type: 'OBJECT',
            properties: {
                url: { type: 'STRING', description: 'The target absolute HTTP/HTTPS URL' }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_snapshot',
        description: 'Get the compact accessibility tree and indexed element IDs of the active web page.',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'browser_extract_content',
        description: 'Extract the full active web page content converted into clean, readable Markdown.',
        parameters: {
            type: 'OBJECT',
            properties: {}
        }
    },
    {
        name: 'browser_click',
        description: 'Perform a mouse click on an interactive element by its numerical data-sb-id or selector.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elementId: { type: 'STRING', description: 'The data-sb-id of the element to click (obtained from browser_snapshot)' },
                selector: { type: 'STRING', description: 'Optional CSS selector of the element' }
            },
            required: ['elementId']
        }
    },
    {
        name: 'browser_type',
        description: 'Type or fill text into an input or textarea element by its numerical data-sb-id.',
        parameters: {
            type: 'OBJECT',
            properties: {
                elementId: { type: 'STRING', description: 'The data-sb-id of the input/textarea element to fill' },
                text: { type: 'STRING', description: 'The text value to type/fill' }
            },
            required: ['elementId', 'text']
        }
    },
    {
        name: 'browser_evaluate',
        description: 'Execute a custom JavaScript expression within the active page context.',
        parameters: {
            type: 'OBJECT',
            properties: {
                expression: { type: 'STRING', description: 'The JavaScript expression to evaluate' }
            },
            required: ['expression']
        }
    }
];

export const browserOutcome = (data: unknown, name: string): ToolHandlerOutcome => ({
    resultPayload: { status: 'success', data },
    summaryResult: `Successfully executed ${name}.`
});

const noActivePageOutcome = (err: NoActiveBrowserPageError): ToolHandlerOutcome => ({
    resultPayload: { status: 'error', code: err.code, error: err.message },
    status: 'failed',
    summaryResult: `Failed (${err.code}): ${err.message}`
});

export const browserHandlers: Record<string, ToolHandler> = {
    async browser_navigate(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('navigate', { url: asString(args.url) }), 'browser_navigate');
    },
    browser_snapshot(_args, ctx) {
        const state = ctx.browserProxy.getActiveState();
        if (!state) return noActivePageOutcome(new NoActiveBrowserPageError());
        if (typeof state.accessibilityTree !== 'string' || !state.accessibilityTree) {
            return noActivePageOutcome(new NoActiveBrowserPageError(`The browser at ${state.url} has not reported an accessibility snapshot yet; wait for the page to load or call browser_navigate again.`));
        }
        return browserOutcome(state, 'browser_snapshot');
    },
    browser_extract_content(_args, ctx) {
        const state = ctx.browserProxy.getActiveState();
        if (!state) return noActivePageOutcome(new NoActiveBrowserPageError());
        if (typeof state.markdown !== 'string' || !state.markdown) {
            return noActivePageOutcome(new NoActiveBrowserPageError(`The browser at ${state.url} has not reported page content yet; wait for the page to load or call browser_navigate again.`));
        }
        return browserOutcome({ url: state.url, markdown: state.markdown }, 'browser_extract_content');
    },
    async browser_click(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('click', { elementId: asString(args.elementId), selector: asString(args.selector) || undefined }), 'browser_click');
    },
    async browser_type(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('fill', { elementId: asString(args.elementId), text: asString(args.text) }), 'browser_type');
    },
    async browser_evaluate(args, ctx) {
        return browserOutcome(await ctx.browserProxy.queueAction('evaluate', { expression: asString(args.expression) }), 'browser_evaluate');
    }
};
