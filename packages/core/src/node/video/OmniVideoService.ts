/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Google Omni video generation through the Vertex AI Interactions API: a blockout video drives the camera
 * move while optional first/last frames pin the opening and closing composition.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { GoogleAuth } from 'google-auth-library';
import { GoogleMediaCredentialsService } from '../google-media-credentials-service';

/** Omni 1.1 Flash on Vertex AI (spce reaches the same model on the Gemini API as the early-access id 'bouncybohr'). */
export const OMNI_VIDEO_MODEL = 'gemini-omni-1.1-flash-preview';
const OMNI_API_REVISION = '2026-05-20';

export interface OmniMedia {
    data: Buffer;
    mimeType: string;
}

export type OmniVideoTask = 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'edit' | 'extend';

export interface OmniBlockoutRequest {
    prompt: string;
    blockoutVideo: OmniMedia;
    firstFrame?: OmniMedia;
    lastFrame?: OmniMedia;
    /** Extra appearance references, sent after the frames (referenced as later @ImageN in the prompt). */
    referenceImages?: OmniMedia[];
    /** Leave unset to let the model infer the task from the prompt tags and media. */
    task?: OmniVideoTask;
}

export interface OmniVideoResult {
    video: Buffer;
    mimeType: string;
    interactionId: string;
    model: string;
    prompt: string;
    elapsedMs: number;
}

export interface OmniVideoServiceOptions {
    fetchImpl?: typeof fetch;
    getAccessToken?: () => Promise<string>;
    credentials?: GoogleMediaCredentialsService;
    project?: string;
    location?: string;
    model?: string;
    /** Interactions API revision header; Omni needs 2026-05-20 or later. */
    apiRevision?: string;
    background?: boolean;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

export interface BlockoutPromptOptions {
    /** Camera move in cinematography terms (what the camera does, not what the frames look like). */
    shot: string;
    emptyStreets?: boolean;
}

export function buildBlockoutFirstLastPrompt({ shot, emptyStreets }: BlockoutPromptOptions): string {
    return [
        '[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <VIDEO_REF_0>@Video1]',
        'Use <FIRST_FRAME> as the literal opening frame and <LAST_FRAME> as the literal closing frame.',
        'Motion & Spatial Guidance: Follow the EXACT 6-DoF camera trajectory, depth parallax, vanishing points, and geometric boundaries of the provided blockout video (<VIDEO_REF_0>). Smoothly propagate the visual identity, architectural textures, and surface materials of <FIRST_FRAME> and <LAST_FRAME> across the entire camera move without morphing, warping, or style drift. <VIDEO_REF_0> is a low-detail 3D map render that defines camera motion and geometry only; do not copy its textures or colors.',
        `Camera: ${shot}`,
        ...(emptyStreets ? ['Scene: The streets and sidewalks stay completely empty for the whole shot: no people, no pedestrians, no vehicles, no traffic.'] : []),
        'Shot Continuity & Timing: Single continuous shot, no scene cuts. Strictly seamless camera movement with zero scene transitions, no camera switching, and no montage edits. Strictly follow the continuous flight trajectory and exact timing of <VIDEO_REF_0>.',
        'Sound design: subtle outdoor atmospheric wind, distant urban ambience. No dialogue, no music.'
    ].join('\n\n');
}

const TERMINAL = new Set(['completed', 'incomplete', 'failed', 'cancelled']);

export class OmniVideoService {
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: OmniVideoServiceOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    async generate(request: OmniBlockoutRequest): Promise<OmniVideoResult> {
        const started = Date.now();
        const model = this.options.model ?? OMNI_VIDEO_MODEL;
        const { project, token } = await this.authorize();
        const location = this.options.location ?? 'global';
        const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
        const base = `https://${host}/v1beta1/projects/${project}/locations/${location}/interactions`;
        const headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Api-Revision': this.options.apiRevision ?? OMNI_API_REVISION
        };

        const media = (type: 'image' | 'video', m: OmniMedia) => ({ type, mime_type: m.mimeType, data: m.data.toString('base64') });
        const input = [
            { type: 'text', text: request.prompt },
            ...(request.firstFrame ? [media('image', request.firstFrame)] : []),
            ...(request.lastFrame ? [media('image', request.lastFrame)] : []),
            media('video', request.blockoutVideo),
            ...(request.referenceImages ?? []).map(r => media('image', r))
        ];
        let interaction = await this.call(base, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                input,
                response_format: { type: 'video' },
                ...(this.options.background !== undefined ? { background: this.options.background } : {}),
                ...(request.task ? { generation_config: { video_config: { task: request.task } } } : {})
            })
        });

        const deadline = started + (this.options.timeoutMs ?? 20 * 60 * 1000);
        while (!TERMINAL.has(interaction.status)) {
            if (!interaction.id) {
                throw new Error(`Omni returned status "${interaction.status}" without an interaction id.`);
            }
            if (Date.now() > deadline) {
                throw new Error(`Omni interaction ${interaction.id} did not finish within ${Math.round((deadline - started) / 1000)} s.`);
            }
            await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs ?? 10000));
            interaction = await this.call(`${base}/${interaction.id}`, { method: 'GET', headers });
        }
        if (interaction.status === 'failed' || interaction.status === 'cancelled') {
            throw new Error(`Omni interaction ${interaction.id} ${interaction.status}: ${interaction.error?.message ?? 'no error message'}`);
        }

        const output = this.findVideo(interaction);
        if (!output) {
            throw new Error(`Omni interaction ${interaction.id} finished (${interaction.status}) with no video.`);
        }
        const video = output.data
            ? Buffer.from(output.data, 'base64')
            : await this.download(output.uri as string, token);
        return {
            video,
            mimeType: output.mime_type ?? output.mimeType ?? 'video/mp4',
            interactionId: interaction.id,
            model,
            prompt: request.prompt,
            elapsedMs: Date.now() - started
        };
    }

    private async authorize(): Promise<{ project: string; token: string }> {
        if (this.options.getAccessToken && this.options.project) {
            return { project: this.options.project, token: await this.options.getAccessToken() };
        }
        const auth = await (this.options.credentials ?? new GoogleMediaCredentialsService()).getVertexAuth();
        const token = this.options.getAccessToken
            ? await this.options.getAccessToken()
            : await new GoogleAuth({
                ...(auth.googleAuthOptions as Record<string, unknown> | undefined),
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            }).getAccessToken();
        if (!token) {
            throw new Error('Could not obtain a Google Cloud access token for Omni.');
        }
        return { project: this.options.project ?? auth.project, token };
    }

    private async call(url: string, init: RequestInit): Promise<any> {
        const res = await this.fetchImpl(url, init);
        const text = await res.text();
        let body: any;
        try {
            body = JSON.parse(text);
        } catch {
            body = { error: { message: text.slice(0, 300) } };
        }
        if (Array.isArray(body)) body = body[0] ?? {};
        if (!res.ok) {
            throw new Error(`Omni request failed (${res.status}): ${body?.error?.message ?? res.statusText}`);
        }
        return body;
    }

    private findVideo(interaction: any): { data?: string; uri?: string; mime_type?: string; mimeType?: string } | undefined {
        for (const step of interaction.steps ?? []) {
            if (step.type !== 'model_output') continue;
            for (const part of step.content ?? []) {
                const mime = part.mime_type ?? part.mimeType ?? '';
                if ((part.type === 'video' || mime.startsWith('video/')) && (part.data || part.uri)) {
                    return part;
                }
            }
        }
        return undefined;
    }

    private async download(uri: string, token: string): Promise<Buffer> {
        const url = uri.startsWith('gs://') ? `https://storage.googleapis.com/${uri.slice(5)}` : uri;
        const googleHosted = url.startsWith('https://storage.googleapis.com/');
        const res = await this.fetchImpl(url, googleHosted ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (!res.ok) {
            throw new Error(`Could not download the Omni video from ${uri} (${res.status}).`);
        }
        return Buffer.from(await res.arrayBuffer());
    }
}
