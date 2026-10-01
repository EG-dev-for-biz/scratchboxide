/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
import { UserMemoriesService } from '../user-memories-service';
import { PlatformDomain } from '../../common/deep-write/deep-write-protocol';
export class UserLearningService {
    constructor(
        protected readonly memoriesService: UserMemoriesService
    ) {}

    /**
     * Inspect user memories to extract preferred tech stacks, target platforms, and coding patterns.
     */
    public async getUserPreferences(workspaceRoot?: string): Promise<{
        languages: string[];
        platforms: PlatformDomain[];
        codingStyle: string;
    }> {
        const languages = new Set<string>();
        const platforms = new Set<PlatformDomain>();
        let codingStyle = '';

        try {
            const memories = await this.memoriesService.listMemories({ workspaceRoot });
            for (const mem of memories) {
                const key = mem.key.toLowerCase();
                const value = mem.value.toLowerCase();

                if (key.includes('language') || key.includes('coding_style')) {
                    if (value.includes('rust')) languages.add('rust');
                    if (value.includes('c++') || value.includes('cpp')) languages.add('cpp');
                    if (value.includes('go')) languages.add('go');
                    if (value.includes('python')) languages.add('python');
                    if (value.includes('typescript') || value.includes('ts')) languages.add('typescript');
                    if (value.includes('swift')) languages.add('swift');
                    if (value.includes('kotlin')) languages.add('kotlin');
                }

                if (key.includes('platform') || key.includes('target')) {
                    if (value.includes('web')) platforms.add('web');
                    if (value.includes('mobile')) platforms.add('mobile');
                    if (value.includes('desktop')) platforms.add('desktop');
                    if (value.includes('cloud') || value.includes('backend')) platforms.add('cloud_backend');
                    if (value.includes('native') || value.includes('systems')) platforms.add('native_systems');
                    if (value.includes('3d') || value.includes('spatial')) platforms.add('spatial_3d');
                }

                if (key.includes('architecture') || key.includes('structure')) {
                    codingStyle += `${mem.value}\n`;
                }
            }
        } catch (err) {
            console.warn('[UserLearningService] Failed to parse user memories:', err);
        }

        // Fallback defaults if no memories exist
        if (languages.size === 0) {
            languages.add('typescript');
            languages.add('cpp');
        }
        if (platforms.size === 0) {
            platforms.add('web');
            platforms.add('spatial_3d');
        }

        return {
            languages: Array.from(languages),
            platforms: Array.from(platforms),
            codingStyle: codingStyle.trim()
        };
    }

    /**
     * Permanently store a newly learned platform and language preference.
     */
    public async learnPlatformPreference(
        platform: PlatformDomain,
        language: string,
        workspaceRoot?: string
    ): Promise<void> {
        try {
            await this.memoriesService.createMemory({
                category: 'coding_style' as any, // fallback or direct key
                key: `Preferred Language for ${platform}`,
                value: language,
                scope: 'global',
                workspaceRoot
            });
            console.log(`[UserLearning] Learned preference: ${platform} -> ${language}`);
        } catch (err) {
            console.warn('[UserLearningService] Failed to store preference:', err);
        }
    }

    /**
     * Analyze user feedback during checkpoints to identify permanent style / preference updates.
     */
    public async learnFromFeedback(feedback: string, workspaceRoot?: string): Promise<void> {
        // Match explicit patterns like "always use X", "prefer Y", "never do Z"
        const alwaysRegex = /\balways\s+use\s+([\w#+\-]+)/i;
        const preferRegex = /\bprefer\s+([\w#+\-]+)/i;
        const neverRegex = /\bnever\s+use\s+([\w#+\-]+)/i;

        let detectedPref: string | null = null;
        let detectedKey = 'Style Directive';

        const alwaysMatch = feedback.match(alwaysRegex);
        if (alwaysMatch) {
            detectedPref = `Always use ${alwaysMatch[1]}`;
            detectedKey = `Always use directive for ${alwaysMatch[1]}`;
        } else {
            const preferMatch = feedback.match(preferRegex);
            if (preferMatch) {
                detectedPref = `Prefer ${preferMatch[1]}`;
                detectedKey = `Preference directive for ${preferMatch[1]}`;
            } else {
                const neverMatch = feedback.match(neverRegex);
                if (neverMatch) {
                    detectedPref = `Never use ${neverMatch[1]}`;
                    detectedKey = `Never use directive for ${neverMatch[1]}`;
                }
            }
        }

        if (detectedPref) {
            try {
                await this.memoriesService.createMemory({
                    category: 'coding_style' as any,
                    key: detectedKey,
                    value: detectedPref,
                    scope: 'workspace',
                    workspaceRoot
                });
                console.log(`[UserLearning] Extracted preference from feedback: "${detectedPref}"`);
            } catch (err) {
                console.warn('[UserLearningService] Failed to save learning memory:', err);
            }
        }
    }
}
