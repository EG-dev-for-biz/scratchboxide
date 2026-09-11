/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { CodebasePatternEngine } from '../src/node/codebase-pattern-engine';

async function runInContextPatternMatchingTestSuite() {
    console.log('🧪 Running In-Context Pattern Matching & Few-Shot Learning Test Suite...');

    const patternEngine = new CodebasePatternEngine();

    // =========================================================================
    // SECTION 1: Convention Extraction from In-Memory File Collections
    // =========================================================================
    console.log('\n--- Section 1: Convention Extraction from Files ---');

    const sampleFiles = [
        {
            path: 'src/services/user-auth-service.ts',
            content: `
import { injectable, inject } from '@theia/core/shared/inversify';

@injectable()
export class UserAuthService {
    async authenticateUser(token: string): Promise<{ success: boolean; userId?: string }> {
        try {
            if (!token) throw new Error('Token required');
            return { success: true, userId: 'user-123' };
        } catch (err: any) {
            console.error('Auth error:', err);
            return { success: false };
        }
    }
}
`
        },
        {
            path: 'src/components/UserProfileCard.tsx',
            content: `
import React, { useState } from 'react';

export interface UserProfileCardProps {
    userName: string;
    avatarUrl?: string;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = (props) => {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="profile-card">
            <h3>{props.userName}</h3>
        </div>
    );
};
`
        },
        {
            path: 'test/user-auth.test.ts',
            content: `
import * as assert from 'assert';

async function testUserAuth() {
    const service = new UserAuthService();
    const res = await service.authenticateUser('valid-token');
    assert.strictEqual(res.success, true);
}
`
        }
    ];

    const analysis = patternEngine.analyzeFilesPatterns(sampleFiles, '/test-workspace');

    // 1. Naming conventions
    assert.strictEqual(analysis.naming.variables, 'camelCase');
    assert.strictEqual(analysis.naming.functions, 'camelCase');
    assert.strictEqual(analysis.naming.classes, 'PascalCase');
    assert.strictEqual(analysis.naming.interfaceNamingStyle, 'Props-suffixed');
    assert.strictEqual(analysis.naming.serviceNamingStyle, 'Service-suffixed');
    console.log('  ✓ Test 1.1 Passed: Naming conventions correctly identified (camelCase, Props-suffixed, Service-suffixed)');

    // 2. Error handling conventions
    assert.ok(['try-catch', 'result-type'].includes(analysis.errorHandling.primaryPattern));
    console.log('  ✓ Test 1.2 Passed: Error handling pattern identified');

    // 3. State & Dependency Injection
    assert.strictEqual(analysis.stateManagement.architecture, 'inversify-di');
    assert.strictEqual(analysis.stateManagement.usesDependencyInjection, true);
    assert.strictEqual(analysis.stateManagement.diFramework, 'inversify');
    console.log('  ✓ Test 1.3 Passed: Inversify Dependency Injection architecture identified');

    // 4. Testing framework
    assert.strictEqual(analysis.testing.framework, 'assert');
    assert.strictEqual(analysis.testing.style, 'assert-strict');
    console.log('  ✓ Test 1.4 Passed: Assert-based unit test convention identified');

    // 5. Few-Shot Exemplars
    assert.ok(analysis.fewShotExemplars.length > 0, 'Should extract few-shot exemplars');
    assert.ok(analysis.fewShotExemplars.some(e => e.category === 'state_management' || e.category === 'testing'));
    console.log('  ✓ Test 1.5 Passed: Few-shot exemplar code snippets extracted');

    // 6. Summary Prompt Context
    assert.ok(analysis.summaryPromptContext.includes('WORKSPACE_ARCHITECTURAL_CONVENTIONS'));
    assert.ok(analysis.summaryPromptContext.includes('FEW-SHOT CODEBASE EXEMPLARS'));
    console.log('  ✓ Test 1.6 Passed: High-reasoning prompt context synthesized cleanly');

    // =========================================================================
    // SECTION 2: Workspace Directory Pattern Scan & Cache
    // =========================================================================
    console.log('\n--- Section 2: Workspace Directory Pattern Scan & Cache ---');

    const tempDir = path.join(os.tmpdir(), `scratchbox-pattern-test-${Date.now()}`);
    await fs.ensureDir(path.join(tempDir, 'src'));

    await fs.writeFile(
        path.join(tempDir, 'src', 'demo-service.ts'),
        `import { injectable } from '@theia/core/shared/inversify';
@injectable()
export class DemoService {}`
    );

    const wsAnalysis1 = await patternEngine.analyzeWorkspacePatterns(tempDir);
    assert.strictEqual(wsAnalysis1.stateManagement.usesDependencyInjection, true);

    // Verify cache hit
    const wsAnalysis2 = await patternEngine.analyzeWorkspacePatterns(tempDir);
    assert.strictEqual(wsAnalysis1.lastAnalyzed, wsAnalysis2.lastAnalyzed, 'Second call should use cached analysis');

    await fs.remove(tempDir);
    console.log('  ✓ Test 2.1 Passed: Workspace directory scanned and cached with TTL');

    console.log('\n🎉 ALL IN-CONTEXT PATTERN MATCHING TESTS PASSED SUCCESSFULLY!');
}

runInContextPatternMatchingTestSuite().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
});
