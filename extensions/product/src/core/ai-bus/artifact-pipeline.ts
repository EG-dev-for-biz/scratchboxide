/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event, IDisposable } from '../events';

export type ArtifactType = 'document' | 'node-graph' | 'kanban' | 'scene-3d' | 'code-sandbox' | string;

export interface IArtifact<T = any> {
    id: string;
    type: ArtifactType;
    title: string;
    content: T;
    version: number;
    metadata?: Record<string, any>;
    createdAt?: number;
    updatedAt?: number;
}

export type PatchType = 'set_value' | 'append_text' | 'replace_text' | 'merge_json' | 'custom';

export interface IArtifactPatch {
    patchType: PatchType;
    path?: string;
    value: any;
}

export interface IArtifactChangeEvent {
    artifactId: string;
    oldVersion: number;
    newVersion: number;
    artifact: IArtifact;
    patch?: IArtifactPatch;
}

export class ArtifactPipeline implements IDisposable {
    private readonly _artifacts = new Map<string, IArtifact>();
    private readonly _history = new Map<string, IArtifact[]>();

    private readonly _onDidChangeArtifact = new Emitter<IArtifactChangeEvent>();
    private readonly _onDidCreateArtifact = new Emitter<IArtifact>();
    private readonly _onDidDeleteArtifact = new Emitter<string>();

    readonly onDidChangeArtifact: Event<IArtifactChangeEvent> = this._onDidChangeArtifact.event;
    readonly onDidCreateArtifact: Event<IArtifact> = this._onDidCreateArtifact.event;
    readonly onDidDeleteArtifact: Event<string> = this._onDidDeleteArtifact.event;

    createArtifact(init: Partial<IArtifact> & { id: string; type: ArtifactType }): IArtifact {
        const now = Date.now();
        const artifact: IArtifact = {
            id: init.id,
            type: init.type,
            title: init.title || `Artifact ${init.id}`,
            content: init.content !== undefined ? JSON.parse(JSON.stringify(init.content)) : {},
            version: init.version || 1,
            metadata: init.metadata ? { ...init.metadata } : {},
            createdAt: init.createdAt || now,
            updatedAt: init.updatedAt || now
        };

        this._artifacts.set(artifact.id, artifact);
        this._history.set(artifact.id, [JSON.parse(JSON.stringify(artifact))]);
        this._onDidCreateArtifact.fire(artifact);

        return artifact;
    }

    getArtifact(id: string): IArtifact | undefined {
        return this._artifacts.get(id);
    }

    getAllArtifacts(): IArtifact[] {
        return Array.from(this._artifacts.values());
    }

    getHistory(id: string): IArtifact[] {
        return this._history.get(id) || [];
    }

    applyPatch(id: string, patch: IArtifactPatch): IArtifact {
        const current = this._artifacts.get(id);
        if (!current) {
            throw new Error(`Artifact not found: ${id}`);
        }

        const oldVersion = current.version;
        const newVersion = oldVersion + 1;
        const now = Date.now();

        // Mutate content based on patch type
        let updatedContent = typeof current.content === 'object' && current.content !== null
            ? JSON.parse(JSON.stringify(current.content))
            : current.content;

        if (patch.patchType === 'append_text') {
            if (patch.path && typeof updatedContent === 'object') {
                const currStr = updatedContent[patch.path] || '';
                updatedContent[patch.path] = String(currStr) + String(patch.value);
            } else if (typeof updatedContent === 'string') {
                updatedContent = updatedContent + String(patch.value);
            }
        } else if (patch.patchType === 'replace_text') {
            if (patch.path && typeof updatedContent === 'object') {
                updatedContent[patch.path] = String(patch.value);
            } else {
                updatedContent = String(patch.value);
            }
        } else if (patch.patchType === 'set_value') {
            if (patch.path && typeof updatedContent === 'object') {
                updatedContent[patch.path] = patch.value;
            } else {
                updatedContent = patch.value;
            }
        } else if (patch.patchType === 'merge_json') {
            if (typeof updatedContent === 'object' && typeof patch.value === 'object') {
                updatedContent = { ...updatedContent, ...patch.value };
            }
        } else {
            updatedContent = patch.value;
        }

        const updatedArtifact: IArtifact = {
            ...current,
            content: updatedContent,
            version: newVersion,
            updatedAt: now
        };

        this._artifacts.set(id, updatedArtifact);
        
        const historyList = this._history.get(id) || [];
        historyList.push(JSON.parse(JSON.stringify(updatedArtifact)));
        this._history.set(id, historyList);

        this._onDidChangeArtifact.fire({
            artifactId: id,
            oldVersion,
            newVersion,
            artifact: updatedArtifact,
            patch
        });

        return updatedArtifact;
    }

    rollbackToVersion(id: string, version: number): IArtifact {
        const historyList = this._history.get(id);
        if (!historyList) {
            throw new Error(`No history found for artifact: ${id}`);
        }

        const target = historyList.find(h => h.version === version);
        if (!target) {
            throw new Error(`Version ${version} not found in history for artifact ${id}`);
        }

        const restored: IArtifact = JSON.parse(JSON.stringify(target));
        restored.updatedAt = Date.now();
        this._artifacts.set(id, restored);

        this._onDidChangeArtifact.fire({
            artifactId: id,
            oldVersion: target.version,
            newVersion: restored.version,
            artifact: restored
        });

        return restored;
    }

    deleteArtifact(id: string): boolean {
        const deleted = this._artifacts.delete(id);
        if (deleted) {
            this._history.delete(id);
            this._onDidDeleteArtifact.fire(id);
        }
        return deleted;
    }

    dispose(): void {
        this._artifacts.clear();
        this._history.clear();
        this._onDidChangeArtifact.dispose();
        this._onDidCreateArtifact.dispose();
        this._onDidDeleteArtifact.dispose();
    }
}
