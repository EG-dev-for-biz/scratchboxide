/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_reference_images: search-grounded reference images of part of a real place (spatial/search-grounded-reference.ts),
 * for recreating it: what the scan cannot resolve (a lantern, ribs, ornament, window rhythm, the real look of a material).
 * Unlike the location evidence tools this reports generated images, labelled so, never measurements.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { MediaModelUnavailableError, MissingInputError } from '../../../common/errors/pipeline-errors';
import { GoogleMediaCredentialsService } from '../../google-media-credentials-service';
import { defaultDurableAssetStore } from '../../asset-store/durable-asset-store';
import { fetchGroundedReferences, type GroundedReferenceClient, type GroundedReferenceResult } from '../../spatial/search-grounded-reference';
import { GENERATED_IMAGES_DIR, resolveRepoRoot, servedGeneratedImageUrl } from './nano-banana-tools';
import type { ToolDeclaration, ToolHandler } from './types';

export interface StoredGroundedReference { model: string; modelVersion?: string; path: string; url?: string; account: string; queries: string[]; sources: Array<{ title?: string; uri?: string }> }

/**
 * Writes an already-fetched search-grounded result's images to `outputDir` (one per model, named from `place subject`),
 * records each in the durable asset store when it is available, and returns them with the file path and served URL. The
 * tool handler below and pipeline G's weak-wall references (pipeline-g/references.ts) both call this, so a reference is
 * stored the same way everywhere: cached across repeat builds of the same place through the asset store's recipe.
 */
export async function storeGroundedReferences(result: GroundedReferenceResult, opts: { place: string; subject: string; view?: string; questions?: string[]; outputDir: string; workspaceRoot?: string }): Promise<StoredGroundedReference[]> {
    await fs.ensureDir(opts.outputDir);
    const stem = `${`${opts.place} ${opts.subject}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)}_${Date.now()}`;
    const store = (() => { try { return defaultDurableAssetStore(); } catch { return undefined; } })();
    const references: StoredGroundedReference[] = [];
    for (const r of result.references) {
        const ext = r.image!.mimeType === 'image/jpeg' ? '.jpg' : '.png';
        const file = path.join(opts.outputDir, `${stem}_${r.model.replace(/[^a-z0-9.-]+/gi, '_')}${ext}`);
        await fs.writeFile(file, r.image!.data);
        const url = servedGeneratedImageUrl(file);
        if (url && store) {
            try {
                const recipeId = `location_reference:${path.basename(file)}`;
                store.putRecipe({ id: recipeId, kind: 'location_reference', workspace: opts.workspaceRoot, body: { place: opts.place, subject: opts.subject, view: opts.view, questions: opts.questions, model: r.model, prompt: result.prompt } });
                store.putFile(file, { servedPath: url, origin: LOCATION_REFERENCE_TOOL_NAME, workspace: opts.workspaceRoot, recipeId, mime: r.image!.mimeType });
            } catch (err) {
                console.warn(`[${LOCATION_REFERENCE_TOOL_NAME}] ${url} was written but not recorded in the asset store: ${(err as Error).message}`);
            }
        }
        references.push({ model: r.model, ...(r.modelVersion ? { modelVersion: r.modelVersion } : {}), path: file, ...(url ? { url } : {}), account: r.account, queries: r.queries, sources: r.sources });
    }
    return references;
}

export const LOCATION_REFERENCE_TOOL_NAME = 'location_reference_images';

export const LOCATION_REFERENCE_TOOL_DECLARATION: ToolDeclaration = {
    name: LOCATION_REFERENCE_TOOL_NAME,
    description: 'Search-grounded reference images of part of a REAL place, for recreating it: Gemini image models with Google Search turned on '
        + 'look the subject up and each draw a faithful reference from the view asked for, with a written account and the search queries and '
        + 'sources they used. Use it for detail a scan or vector data cannot resolve: what tops a dome or tower, rib or bay counts, window rhythm, '
        + 'ornament, the real look of a facade material or paving. The images are GENERATED (provenance generated, basis search-grounded '
        + 'reference), never measurements: geometry and size come from the scan and vector data; take a detail from these references only where '
        + 'the independent references (one per model) agree and the scan does not contradict them, and label what you take as generated.',
    parameters: {
        type: 'OBJECT',
        properties: {
            place: { type: 'STRING', description: 'The real place, as a name or address (e.g. "Flinders Street Station, Melbourne").' },
            subject: { type: 'STRING', description: 'What to show (e.g. "the dome and its lantern", "the facade facing Swanston Street", "the plaza paving close up").' },
            view: { type: 'STRING', description: 'Optional: where the view is from (e.g. "from Flinders Street at eye level", "straight on").' },
            questions: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional: what the written account must answer (e.g. "what stands on the lantern").' },
            aspectRatio: { type: 'STRING', description: 'Optional image aspect ratio (e.g. "4:3", "16:9", "1:1"). Default 4:3.' }
        },
        required: ['place', 'subject']
    }
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function createLocationReferenceHandler(deps: { client?: () => Promise<GroundedReferenceClient>; outputDir?: string } = {}): ToolHandler {
    return async (args, ctx) => {
        const place = str(args.place), subject = str(args.subject);
        if (!place) throw new MissingInputError(LOCATION_REFERENCE_TOOL_NAME, 'place', 'the real place, as a name or address');
        if (!subject) throw new MissingInputError(LOCATION_REFERENCE_TOOL_NAME, 'subject', 'what to show');
        let client: GroundedReferenceClient;
        try {
            client = deps.client ? await deps.client() : (await new GoogleMediaCredentialsService().createVertexClient()) as unknown as GroundedReferenceClient;
        } catch (err) {
            throw new MediaModelUnavailableError('gemini-3-pro-image', `Google media credentials are not available (${(err as Error)?.message || err})`);
        }
        ctx?.reportProgress?.('Searching and drawing references', 0);
        const questions = Array.isArray(args.questions) ? args.questions.map(str).filter(Boolean) : undefined;
        const result = await fetchGroundedReferences(client, { place, subject, view: str(args.view) || undefined, questions, aspectRatio: str(args.aspectRatio) || '4:3' }, { signal: ctx?.signal });
        const outputDir = deps.outputDir ?? path.resolve(resolveRepoRoot(), GENERATED_IMAGES_DIR, 'location_reference');
        const references = await storeGroundedReferences(result, { place, subject, view: str(args.view) || undefined, questions, outputDir, workspaceRoot: ctx?.workspaceRoot });
        const markdown = references.map(r => (r.url ? `![${subject} (${r.model})](${r.url})` : '')).filter(Boolean).join('\n');
        const summary = `${references.length} search-grounded reference${references.length === 1 ? '' : 's'} of ${subject} of ${place} (${references.map(r => r.model).join(', ')})`
            + `${result.skipped.length ? `; skipped ${result.skipped.map(s => `${s.model} (${s.reason})`).join(', ')}` : ''}. Generated references, not measurements: use what they agree on and the scan does not contradict.`;
        return {
            resultPayload: { success: true, provenance: result.provenance, place, subject, prompt: result.prompt, references, skipped: result.skipped, markdown, summary },
            summaryResult: summary
        };
    };
}

export const LOCATION_REFERENCE_TOOL_DECLARATIONS: ToolDeclaration[] = [LOCATION_REFERENCE_TOOL_DECLARATION];

export const locationReferenceHandlers: Record<string, ToolHandler> = {
    [LOCATION_REFERENCE_TOOL_NAME]: createLocationReferenceHandler()
};
