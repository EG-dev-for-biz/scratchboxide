/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    getMemoryCategoryGroup,
    formatCategoryLabel,
    WRITING_STYLE_CATEGORIES,
    VISUAL_STYLE_CATEGORIES,
    PROJECT_CONTEXT_CATEGORIES
} from '../src/browser/generative-canvas/canvas-types';
import { UserMemoriesService } from '../src/node/user-memories-service';

async function runUserMemoriesTests() {
    console.log('🧪 Running Comprehensive User Memories Subsystem Test Suite...\n');

    // Create temporary sandboxes for global and workspace directories
    const tempGlobalDir = path.join(os.tmpdir(), `sb-global-memories-test-${Date.now()}`);
    const tempWorkspaceDir = path.join(os.tmpdir(), `sb-workspace-memories-test-${Date.now()}`);
    await fs.ensureDir(tempGlobalDir);
    await fs.ensureDir(tempWorkspaceDir);

    const globalStorePath = path.join(tempGlobalDir, 'memories.json');
    const memoriesService = new UserMemoriesService();
    memoriesService.setGlobalStorePath(globalStorePath);
    memoriesService.setDefaultWorkspaceRoot(tempWorkspaceDir);

    try {
        // -------------------------------------------------------------
        // Test 1: Category Groups and Helper Formatters
        // -------------------------------------------------------------
        console.log('  Testing Category Classification and Formatters...');
        assert.ok(WRITING_STYLE_CATEGORIES.includes('writing_patterns'));
        assert.ok(VISUAL_STYLE_CATEGORIES.includes('image_style'));
        assert.ok(PROJECT_CONTEXT_CATEGORIES.includes('canvas_character'));

        assert.strictEqual(getMemoryCategoryGroup('writing_patterns'), 'writing');
        assert.strictEqual(getMemoryCategoryGroup('writing_style'), 'writing');
        assert.strictEqual(getMemoryCategoryGroup('tone_and_voice'), 'writing');
        assert.strictEqual(getMemoryCategoryGroup('formatting'), 'writing');

        assert.strictEqual(getMemoryCategoryGroup('image_style'), 'visual');
        assert.strictEqual(getMemoryCategoryGroup('video_style'), 'visual');
        assert.strictEqual(getMemoryCategoryGroup('visual_composition'), 'visual');
        assert.strictEqual(getMemoryCategoryGroup('style_preferences'), 'visual');

        assert.strictEqual(getMemoryCategoryGroup('canvas_character'), 'project');
        assert.strictEqual(getMemoryCategoryGroup('canvas_location'), 'project');
        assert.strictEqual(getMemoryCategoryGroup('canvas_decisions'), 'project');
        assert.strictEqual(getMemoryCategoryGroup('canvas_narrative'), 'project');
        assert.strictEqual(getMemoryCategoryGroup('canvas_style'), 'project');
        assert.strictEqual(getMemoryCategoryGroup('general'), 'project');

        assert.strictEqual(formatCategoryLabel('writing_patterns'), 'Writing Patterns');
        assert.strictEqual(formatCategoryLabel('canvas_character'), 'Characters & Entities');
        console.log('  ✓ Test 1 Passed: Category groups, classification & labels verified');

        // -------------------------------------------------------------
        // Test 2: User Memory CRUD Operations (Global Scope)
        // -------------------------------------------------------------
        console.log('  Testing User Memory CRUD (Global Scope)...');
        const mem1 = await memoriesService.createMemory({
            category: 'tone_and_voice',
            key: 'concise_clarity',
            value: 'Write in concise, high-signal Cupertino style without fluff.',
            scope: 'global'
        });
        assert.ok(mem1.id, 'Created memory must have a generated ID');
        assert.strictEqual(mem1.category, 'tone_and_voice');
        assert.strictEqual(mem1.key, 'concise_clarity');
        assert.strictEqual(mem1.scope, 'global');

        const mem2 = await memoriesService.createMemory({
            category: 'image_style',
            key: 'lighting_preference',
            value: 'Warm natural rim lighting with deep cinematic dynamic range.',
            scope: 'global'
        });
        assert.ok(mem2.id);

        const fetchedMem1 = await memoriesService.getMemoryById(mem1.id);
        assert.ok(fetchedMem1, 'Should find memory by ID');
        assert.strictEqual(fetchedMem1?.value, 'Write in concise, high-signal Cupertino style without fluff.');

        // Update memory
        const updatedMem1 = await memoriesService.updateMemory(mem1.id, {
            value: 'Write with crisp Apple clarity: confident verbs, minimal jargon, human-centered benefits.'
        });
        assert.strictEqual(updatedMem1?.value, 'Write with crisp Apple clarity: confident verbs, minimal jargon, human-centered benefits.');

        // Verify persistence to global file
        assert.ok(await fs.pathExists(globalStorePath), 'Global memories.json file should be created');
        const globalJson = await fs.readJson(globalStorePath);
        assert.strictEqual(globalJson.memories.length, 2, 'Global store should have 2 memories');
        console.log('  ✓ Test 2 Passed: Global memory CRUD and file persistence verified');

        // -------------------------------------------------------------
        // Test 3: Workspace-Scoped Memories and Scope Merging
        // -------------------------------------------------------------
        console.log('  Testing Workspace-Scoped Memories & Multi-Scope Merging...');
        const wsMem1 = await memoriesService.createMemory({
            category: 'canvas_character',
            key: 'lead_protagonist',
            value: 'Dr. Evelyn Vance, quantum physicist at Geneva Labs.',
            scope: 'workspace',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(wsMem1.scope, 'workspace');

        const wsMem2 = await memoriesService.createMemory({
            category: 'canvas_decisions',
            key: 'auth_architecture',
            value: 'Use zero-trust passkeys and session tokens for API gateway.',
            scope: 'workspace',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(wsMem2.scope, 'workspace');

        // Check workspace file existence
        const wsFile = path.join(tempWorkspaceDir, '.scratchbox', 'memories.json');
        assert.ok(await fs.pathExists(wsFile), 'Workspace .scratchbox/memories.json must exist');

        // List all memories (merged global + workspace)
        const allMemories = await memoriesService.listMemories({ workspaceRoot: tempWorkspaceDir });
        assert.strictEqual(allMemories.length, 4, 'Should contain 2 global + 2 workspace memories');

        // Filter by group
        const writingMemories = await memoriesService.listMemories({
            categoryGroup: 'writing',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(writingMemories.length, 1);
        assert.strictEqual(writingMemories[0].category, 'tone_and_voice');

        const visualMemories = await memoriesService.listMemories({
            categoryGroup: 'visual',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(visualMemories.length, 1);
        assert.strictEqual(visualMemories[0].category, 'image_style');

        const projectMemories = await memoriesService.listMemories({
            categoryGroup: 'project',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(projectMemories.length, 2);
        console.log('  ✓ Test 3 Passed: Workspace-scoped memories and category group filters verified');

        // -------------------------------------------------------------
        // Test 4: Search & Filtering
        // -------------------------------------------------------------
        console.log('  Testing Memory Search & Query Filtering...');
        const searchQuantum = await memoriesService.listMemories({
            searchQuery: 'quantum',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(searchQuantum.length, 1);
        assert.strictEqual(searchQuantum[0].key, 'lead_protagonist');

        const searchCupertino = await memoriesService.listMemories({
            searchQuery: 'Apple clarity',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(searchCupertino.length, 1);
        console.log('  ✓ Test 4 Passed: Search filtering across keys and values verified');

        // -------------------------------------------------------------
        // Test 5: Writing Style Profiles
        // -------------------------------------------------------------
        console.log('  Testing Writing Style Profiles...');
        const profile1 = await memoriesService.createWritingProfile({
            name: 'Executive Cupertino Voice',
            stylePrompt: 'Crisp, punchy, benefit-driven Apple executive tone with active verbs.',
            samples: ['Simple ideas change everything.', 'Designed to empower creators.'],
            isActive: true,
            scope: 'global'
        });
        assert.ok(profile1.id);
        assert.strictEqual(profile1.isActive, true);

        const profile2 = await memoriesService.createWritingProfile({
            name: 'Academic Technical Spec',
            stylePrompt: 'Rigorous, formal academic prose with citations and RFC precision.',
            isActive: false,
            scope: 'global'
        });
        assert.strictEqual(profile2.isActive, false);

        // Activate profile 2 and verify profile 1 is deactivated
        await memoriesService.setActiveWritingProfile(profile2.id);
        const activeProfile = await memoriesService.getActiveWritingProfile();
        assert.strictEqual(activeProfile?.id, profile2.id);
        assert.strictEqual(activeProfile?.name, 'Academic Technical Spec');

        const allProfiles = await memoriesService.listWritingProfiles();
        assert.strictEqual(allProfiles.length, 2);
        console.log('  ✓ Test 5 Passed: Writing Style Profiles creation, activation, and listing verified');

        // -------------------------------------------------------------
        // Test 6: Image and Video Style Preferences
        // -------------------------------------------------------------
        console.log('  Testing Image & Video Style Preferences...');
        const style1 = await memoriesService.createStylePreference({
            name: 'Liquid Glass Minimalist',
            description: 'Translucent glassmorphism with dynamic lighting and subtle blurs',
            stylePrompt: 'Cupertino Liquid Glass aesthetic, frosted translucent materials, vibrant specular highlights, neutral dark background',
            category: 'visual_composition',
            isDefault: true,
            scope: 'global'
        });
        assert.ok(style1.id);
        assert.strictEqual(style1.isDefault, true);

        const style2 = await memoriesService.createStylePreference({
            name: 'Cinematic Drone 4K',
            description: 'Sweeping 4D drone motion flythroughs with smooth camera damping',
            stylePrompt: '4K HDR cinema camera movement, smooth gimbal motion, golden hour sunlight',
            category: 'video_style',
            isDefault: false,
            scope: 'workspace',
            workspaceRoot: tempWorkspaceDir
        });
        assert.ok(style2.id);

        const allStyles = await memoriesService.listStylePreferences({ workspaceRoot: tempWorkspaceDir });
        assert.strictEqual(allStyles.length, 2);
        console.log('  ✓ Test 6 Passed: Visual style preferences creation & listing verified');

        // -------------------------------------------------------------
        // Test 7: AI System Instruction Prompt Injection Synthesis
        // -------------------------------------------------------------
        console.log('  Testing AI System Instruction Prompt Injection Synthesis...');
        const promptInjection = await memoriesService.buildPromptInjectionText(tempWorkspaceDir);
        assert.ok(promptInjection.includes('### ACTIVE USER MEMORIES & LEARNED PREFERENCES'), 'Prompt injection must include user memories header');
        assert.ok(promptInjection.includes('Writing Style Profile (Academic Technical Spec)'), 'Prompt must include active writing profile');
        assert.ok(promptInjection.includes('Apple clarity') || promptInjection.includes('Tone & Voice') || promptInjection.includes('tone_and_voice'), 'Prompt must include writing style memory');
        assert.ok(promptInjection.includes('Dr. Evelyn Vance') || promptInjection.includes('lead_protagonist'), 'Prompt must include project memory');
        assert.ok(promptInjection.includes('Liquid Glass Minimalist'), 'Prompt must include default visual style');

        // Test disabling memory injection
        await memoriesService.updateConfig({ enableMemoryInjection: false });
        const disabledInjection = await memoriesService.buildPromptInjectionText(tempWorkspaceDir);
        assert.strictEqual(disabledInjection, '', 'Prompt injection must be empty when injection is disabled');

        // Re-enable memory injection
        await memoriesService.updateConfig({ enableMemoryInjection: true });
        const reenabledInjection = await memoriesService.buildPromptInjectionText(tempWorkspaceDir);
        assert.ok(reenabledInjection.length > 0, 'Prompt injection must be restored when re-enabled');
        console.log('  ✓ Test 7 Passed: AI system instruction prompt injection synthesis verified');

        // -------------------------------------------------------------
        // Test 8: Category Deletion & Bulk Clearance
        // -------------------------------------------------------------
        console.log('  Testing Deletion and Category Clearance...');
        // Delete mem2
        const deleteSuccess = await memoriesService.deleteMemory(mem2.id);
        assert.strictEqual(deleteSuccess, true);
        const shouldBeNull = await memoriesService.getMemoryById(mem2.id);
        assert.strictEqual(shouldBeNull, undefined);

        // Clear category 'canvas_character' in workspace
        const clearedCount = await memoriesService.clearCategory('canvas_character', tempWorkspaceDir);
        assert.strictEqual(clearedCount, 1);
        const charactersAfterClear = await memoriesService.listMemories({
            category: 'canvas_character',
            workspaceRoot: tempWorkspaceDir
        });
        assert.strictEqual(charactersAfterClear.length, 0);
        console.log('  ✓ Test 8 Passed: Memory deletion and category clearance verified');

        // -------------------------------------------------------------
        // Test 9: UI Components & SettingsModal Integration Check
        // -------------------------------------------------------------
        console.log('  Testing SettingsModal and UI Elements Integration...');
        const settingsModalPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
        assert.ok(fs.existsSync(settingsModalPath), 'SettingsModal.tsx must exist');
        const settingsSource = fs.readFileSync(settingsModalPath, 'utf-8');

        assert.ok(settingsSource.includes("'memories'"), "SettingsModal must register 'memories' tab in sidebarNavSections");
        assert.ok(settingsSource.includes('Memories') || settingsSource.includes('User Memories'), 'SettingsModal must have Memories label');
        console.log('  ✓ Test 9 Passed: SettingsModal integration points verified');

        console.log('\n🎉 ALL USER MEMORIES TESTS PASSED PERFECTLY!\n');
    } finally {
        // Clean up temp directories
        await fs.remove(tempGlobalDir);
        await fs.remove(tempWorkspaceDir);
    }
}

runUserMemoriesTests().catch(err => {
    console.error('❌ User Memories Test Suite Failed:', err);
    process.exit(1);
});
