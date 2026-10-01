/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as path from 'path';
import { WorkspaceConfigService } from '../workspace-config-service';
import { WorkspaceFileWatcherService } from '../workspace-file-watcher-service';
export class CodebaseLensSyncService {
    constructor(
        protected readonly configService: WorkspaceConfigService,
        protected readonly fileWatcher?: WorkspaceFileWatcherService
    ) {}

    /**
     * Atomically write a set of Deep-Write deliverables directly to the physical filesystem on disk,
     * registering hashes with the watcher service to suppress echo-update loops.
     */
    public async syncBundleToWorkspace(
        workspaceRoot: string,
        files: Record<string, string>
    ): Promise<{ success: boolean; writtenFiles: string[]; error?: string }> {
        try {
            console.log(`[CodebaseLensSync] Projecting ${Object.keys(files).length} files to workspace on disk at ${workspaceRoot}`);
            const result = await this.configService.writeLensFiles(
                workspaceRoot,
                files,
                this.fileWatcher
            );
            return result;
        } catch (err: any) {
            console.error('[CodebaseLensSync] Failed to sync files:', err);
            return {
                success: false,
                writtenFiles: [],
                error: err.message || 'Error occurred during codebase lens sync.'
            };
        }
    }

    /**
     * Read targeted disk files from workspace into a in-memory record to serve as seed context.
     */
    public async projectDiskToPrimitive(
        workspaceRoot: string,
        filePaths: string[]
    ): Promise<Record<string, string>> {
        const result: Record<string, string> = {};
        for (const relPath of filePaths) {
            try {
                const fullPath = path.join(workspaceRoot, relPath);
                if (await fs.pathExists(fullPath)) {
                    const content = await fs.readFile(fullPath, 'utf8');
                    result[relPath] = content;
                }
            } catch (err) {
                console.warn(`[CodebaseLensSync] Failed to read ${relPath} from disk:`, err);
            }
        }
        return result;
    }
}
