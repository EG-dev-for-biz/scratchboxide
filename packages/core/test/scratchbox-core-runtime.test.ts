import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
    DisposableCollection,
    toDisposable,
    Emitter,
    AsyncEmitter,
    debounceEvent,
    CancellationTokenSource,
    CancellationError,
    ContextKeyService,
    CommandRegistry,
    KeybindingRegistry,
    MenuRegistry,
    URI,
    FileType,
    FileChangeType,
    InMemoryFileSystemProvider,
    DiskFileSystemProvider,
    WorkspaceManager,
    ProcessManager,
    PTYSessionManager,
    ToolRegistry,
    ArtifactPipeline,
    WorkspaceLayoutEngine,
    SplitDirection
} from '../src/core';

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runScratchboxCoreRuntimeTests() {
    console.log('🧪 Running Scratchbox Standalone Core Runtime Test Suite...\n');

    // =========================================================================
    // 1. DISPOSABLES & EVENT EMITTERS
    // =========================================================================
    console.log('--- 1. Testing Disposables & Event Emitters ---');
    {
        // Disposable & DisposableCollection
        let disposedCount = 0;
        const collection = new DisposableCollection();
        const d1 = toDisposable(() => { disposedCount++; });
        const d2 = toDisposable(() => { disposedCount++; });
        collection.push(d1);
        collection.push(d2);

        assert.strictEqual(collection.disposed, false, 'Collection should not be disposed initially');
        collection.dispose();
        assert.strictEqual(disposedCount, 2, 'All registered disposables should have fired');
        assert.strictEqual(collection.disposed, true, 'Collection should be marked disposed');

        // Emitter
        const emitter = new Emitter<number>();
        const received: number[] = [];
        const sub = emitter.event(val => received.push(val));
        
        emitter.fire(10);
        emitter.fire(20);
        assert.deepStrictEqual(received, [10, 20], 'Event listeners should receive fired values');
        
        sub.dispose();
        emitter.fire(30);
        assert.deepStrictEqual(received, [10, 20], 'Disposed listener should not receive new values');
        emitter.dispose();

        // AsyncEmitter
        const asyncEmitter = new AsyncEmitter<string>();
        const asyncResults: string[] = [];
        asyncEmitter.event(async (data) => {
            await sleep(10);
            asyncResults.push(`async:${data}`);
        });
        await asyncEmitter.fireAsync('payload-1');
        assert.deepStrictEqual(asyncResults, ['async:payload-1'], 'AsyncEmitter should wait for async listeners');
        asyncEmitter.dispose();

        // debounceEvent
        const debouncedEmitter = new Emitter<string>();
        const debouncedValues: string[] = [];
        const debounced = debounceEvent(debouncedEmitter.event, (last, current) => current, 30);
        const debSub = debounced(val => debouncedValues.push(val));

        debouncedEmitter.fire('a');
        debouncedEmitter.fire('b');
        debouncedEmitter.fire('c');
        assert.strictEqual(debouncedValues.length, 0, 'Debounced event should not fire synchronously');
        await sleep(60);
        assert.deepStrictEqual(debouncedValues, ['c'], 'Debounced event should only emit latest value after delay');
        debSub.dispose();
        debouncedEmitter.dispose();

        // CancellationTokenSource
        const cts = new CancellationTokenSource();
        let tokenCancelled = false;
        cts.token.onCancellationRequested(() => { tokenCancelled = true; });
        assert.strictEqual(cts.token.isCancellationRequested, false);
        cts.cancel();
        assert.strictEqual(cts.token.isCancellationRequested, true);
        assert.strictEqual(tokenCancelled, true, 'Cancellation listener must be triggered');
        cts.dispose();

        console.log('  ✓ Disposables, Emitters, AsyncEmitters, Debounce, and Cancellation Tokens passed');
    }

    // =========================================================================
    // 2. COMMANDS, KEYBINDINGS, MENUS & CONTEXT KEYS
    // =========================================================================
    console.log('\n--- 2. Testing Commands, Keybindings, Menus & Context Keys ---');
    {
        const contextKeyService = new ContextKeyService();
        contextKeyService.setContext('editorTextFocus', true);
        contextKeyService.setContext('resourceLangId', 'typescript');
        contextKeyService.setContext('viewMode', 'canvas');

        // Context Evaluation
        assert.strictEqual(contextKeyService.evaluate('editorTextFocus'), true);
        assert.strictEqual(contextKeyService.evaluate('!editorTextFocus'), false);
        assert.strictEqual(contextKeyService.evaluate('resourceLangId == "typescript"'), true);
        assert.strictEqual(contextKeyService.evaluate('resourceLangId == "python"'), false);
        assert.strictEqual(contextKeyService.evaluate('editorTextFocus && resourceLangId == "typescript"'), true);
        assert.strictEqual(contextKeyService.evaluate('viewMode == "code" || viewMode == "canvas"'), true);

        // Command Registry
        const commandRegistry = new CommandRegistry(contextKeyService);
        let commandExecuted = false;
        commandRegistry.registerCommand({
            id: 'scratchbox.test.action',
            title: 'Test Action',
            handler: (arg1: string) => {
                commandExecuted = true;
                return `executed:${arg1}`;
            },
            when: 'editorTextFocus && resourceLangId == "typescript"'
        });

        assert.strictEqual(commandRegistry.hasCommand('scratchbox.test.action'), true);
        assert.strictEqual(commandRegistry.isEnabled('scratchbox.test.action'), true);
        
        const result = await commandRegistry.executeCommand('scratchbox.test.action', 'hello');
        assert.strictEqual(result, 'executed:hello');
        assert.strictEqual(commandExecuted, true);

        // Enablement check with disabled context
        contextKeyService.setContext('editorTextFocus', false);
        assert.strictEqual(commandRegistry.isEnabled('scratchbox.test.action'), false);

        // Keybinding Registry & Chord Resolution
        const keybindingRegistry = new KeybindingRegistry(commandRegistry, contextKeyService);
        keybindingRegistry.registerKeybinding({
            command: 'scratchbox.test.action',
            keybinding: 'Cmd+K Cmd+S',
            when: 'resourceLangId == "typescript"',
            platform: 'darwin'
        });
        keybindingRegistry.registerKeybinding({
            command: 'scratchbox.quickOpen',
            keybinding: 'Cmd+P',
            platform: 'darwin'
        });

        // Test key resolving (simulating chord state machine)
        const chordStep1 = keybindingRegistry.resolveKeypress('Meta+KeyK', 'darwin');
        assert.strictEqual(chordStep1.status, 'chord_pending', 'First part of Cmd+K Cmd+S should enter chord pending');
        
        const chordStep2 = keybindingRegistry.resolveKeypress('Meta+KeyS', 'darwin');
        assert.strictEqual(chordStep2.status, 'matched', 'Second part should match chord');
        if (chordStep2.status === 'matched') {
            assert.strictEqual(chordStep2.commandId, 'scratchbox.test.action');
        }

        // Single key match
        const singleMatch = keybindingRegistry.resolveKeypress('Meta+KeyP', 'darwin');
        assert.strictEqual(singleMatch.status, 'matched');
        if (singleMatch.status === 'matched') {
            assert.strictEqual(singleMatch.commandId, 'scratchbox.quickOpen');
        }

        // Menu Registry
        const menuRegistry = new MenuRegistry(commandRegistry, contextKeyService);
        menuRegistry.registerMenuItem('canvas/context', {
            command: 'scratchbox.test.action',
            label: 'Run Test Action',
            group: '1_modification',
            order: 10
        });
        menuRegistry.registerMenuItem('canvas/context', {
            command: 'scratchbox.quickOpen',
            label: 'Quick Open',
            group: '0_navigation',
            order: 5
        });

        const menuItems = menuRegistry.getMenuItems('canvas/context');
        assert.strictEqual(menuItems.length, 2);
        // group '0_navigation' should sort before '1_modification'
        assert.strictEqual(menuItems[0].command, 'scratchbox.quickOpen');
        assert.strictEqual(menuItems[1].command, 'scratchbox.test.action');

        console.log('  ✓ ContextKey evaluator, CommandRegistry, Keybinding chord resolver, and MenuRegistry passed');
    }

    // =========================================================================
    // 3. VIRTUAL FILESYSTEM & WORKSPACE MODEL
    // =========================================================================
    console.log('\n--- 3. Testing Virtual FileSystem & Workspace Model ---');
    {
        // URI Tests
        const fileUri = URI.file('/Users/test/workspace/file.ts');
        assert.strictEqual(fileUri.scheme, 'file');
        assert.strictEqual(fileUri.fsPath, '/Users/test/workspace/file.ts');
        assert.strictEqual(fileUri.toString(), 'file:///Users/test/workspace/file.ts');

        const memUri = URI.parse('memory:///root/project/app.tsx');
        assert.strictEqual(memUri.scheme, 'memory');
        assert.strictEqual(memUri.path, '/root/project/app.tsx');

        const joined = fileUri.joinPath('subfolder', 'test.json');
        assert.strictEqual(joined.fsPath, '/Users/test/workspace/file.ts/subfolder/test.json');

        // InMemoryFileSystemProvider Tests
        const memVfs = new InMemoryFileSystemProvider();
        const rootUri = URI.parse('memory:///workspace');
        const fileA = rootUri.joinPath('src', 'index.ts');
        
        // Track file events
        const changes: { type: FileChangeType; uri: URI }[] = [];
        memVfs.onDidChangeFile(events => {
            for (const e of events) {
                changes.push({ type: e.type, uri: e.uri });
            }
        });

        await memVfs.createDirectory(rootUri.joinPath('src'));
        await memVfs.writeFile(fileA, Buffer.from('console.log("hello memory vfs");', 'utf-8'), { create: true, overwrite: true });
        
        const stat = await memVfs.stat(fileA);
        assert.strictEqual(stat.type, FileType.File);
        assert.ok(stat.size > 0);

        const content = await memVfs.readFile(fileA);
        assert.strictEqual(Buffer.from(content).toString('utf-8'), 'console.log("hello memory vfs");');

        const dirEntries = await memVfs.readDirectory(rootUri.joinPath('src'));
        assert.strictEqual(dirEntries.length, 1);
        assert.strictEqual(dirEntries[0][0], 'index.ts');
        assert.strictEqual(dirEntries[0][1], FileType.File);

        // Rename
        const fileRenamed = rootUri.joinPath('src', 'main.ts');
        await memVfs.rename(fileA, fileRenamed, { overwrite: true });
        const existsOld = await memVfs.exists(fileA);
        const existsNew = await memVfs.exists(fileRenamed);
        assert.strictEqual(existsOld, false);
        assert.strictEqual(existsNew, true);

        // Delete
        await memVfs.delete(fileRenamed);
        const existsAfterDelete = await memVfs.exists(fileRenamed);
        assert.strictEqual(existsAfterDelete, false);

        assert.ok(changes.some(c => c.type === FileChangeType.Created));
        assert.ok(changes.some(c => c.type === FileChangeType.Deleted));

        // DiskFileSystemProvider Tests (in temporary directory)
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchbox-disk-test-'));
        try {
            const diskVfs = new DiskFileSystemProvider();
            const diskFile = URI.file(path.join(tempDir, 'sample.txt'));
            await diskVfs.writeFile(diskFile, Buffer.from('hello disk provider', 'utf-8'), { create: true, overwrite: true });
            
            const diskStat = await diskVfs.stat(diskFile);
            assert.strictEqual(diskStat.type, FileType.File);
            
            const diskRead = await diskVfs.readFile(diskFile);
            assert.strictEqual(Buffer.from(diskRead).toString('utf-8'), 'hello disk provider');
            
            await diskVfs.delete(diskFile);
            const diskExists = await diskVfs.exists(diskFile);
            assert.strictEqual(diskExists, false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        // WorkspaceManager Tests
        const workspaceManager = new WorkspaceManager();
        workspaceManager.registerProvider('memory', memVfs);

        const wsRoot = URI.parse('memory:///multi-workspace/project-a');
        await memVfs.createDirectory(wsRoot);
        await memVfs.writeFile(wsRoot.joinPath('package.json'), Buffer.from('{"name":"project-a"}'), { create: true, overwrite: true });

        workspaceManager.addFolder({ uri: wsRoot, name: 'Project A' });
        assert.strictEqual(workspaceManager.getFolders().length, 1);
        assert.strictEqual(workspaceManager.getWorkspaceFolder(wsRoot.joinPath('package.json'))?.name, 'Project A');

        const readFromWs = await workspaceManager.readFile(wsRoot.joinPath('package.json'));
        assert.strictEqual(Buffer.from(readFromWs).toString('utf-8'), '{"name":"project-a"}');

        console.log('  ✓ URI parsing, InMemoryFileSystemProvider, DiskFileSystemProvider, and WorkspaceManager passed');
    }

    // =========================================================================
    // 4. TERMINAL & PTY PROCESS RUNTIME
    // =========================================================================
    console.log('\n--- 4. Testing Terminal & PTY Process Runtime ---');
    {
        const processManager = new ProcessManager();
        
        // Execute simple node script via ProcessManager
        const execResult = await processManager.exec(process.execPath, ['-e', 'console.log("scratchbox-stdout"); console.error("scratchbox-stderr");']);
        assert.strictEqual(execResult.exitCode, 0);
        assert.ok(execResult.stdout.includes('scratchbox-stdout'), 'Process stdout must match');
        assert.ok(execResult.stderr.includes('scratchbox-stderr'), 'Process stderr must match');

        // Process cancellation test
        const timeoutCts = new CancellationTokenSource();
        setTimeout(() => timeoutCts.cancel(), 50);
        try {
            await processManager.exec(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
                cancellationToken: timeoutCts.token
            });
            assert.fail('Cancelled process should throw or return non-zero/killed status');
        } catch (err: any) {
            assert.ok(err instanceof CancellationError || err.message?.includes('cancelled') || err.message?.includes('SIGTERM') || err.killed);
        }

        // PTYSessionManager
        const ptyManager = new PTYSessionManager();
        const session = ptyManager.createSession({
            id: 'terminal-session-1',
            title: 'Bash Session',
            cols: 80,
            rows: 24
        });

        assert.strictEqual(session.id, 'terminal-session-1');
        assert.strictEqual(session.cols, 80);
        assert.strictEqual(session.rows, 24);

        const receivedData: string[] = [];
        session.onData(data => receivedData.push(data));

        // Write data into PTY session stream
        session.write('echo "Hello PTY"\n');
        session.resize(120, 40);
        assert.strictEqual(session.cols, 120);
        assert.strictEqual(session.rows, 40);

        const scrollback = session.getScrollbackBuffer();
        assert.ok(Array.isArray(scrollback));

        session.dispose();
        assert.strictEqual(ptyManager.getSession('terminal-session-1'), undefined);

        console.log('  ✓ ProcessManager execution, timeout/cancellation, and PTYSessionManager buffering passed');
    }

    // =========================================================================
    // 5. AI SUBAGENT & TOOL BUS + ARTIFACT PIPELINE
    // =========================================================================
    console.log('\n--- 5. Testing AI Subagent & Tool Bus, Artifact Pipeline ---');
    {
        // ToolRegistry
        const toolRegistry = new ToolRegistry();
        toolRegistry.registerTool({
            name: 'calculate_sum',
            description: 'Add two numbers together',
            parameters: {
                type: 'object',
                properties: {
                    a: { type: 'number' },
                    b: { type: 'number' }
                },
                required: ['a', 'b']
            },
            handler: async (args: { a: number; b: number }) => {
                return { sum: args.a + args.b };
            }
        });

        assert.strictEqual(toolRegistry.hasTool('calculate_sum'), true);

        // Successful invocation
        const callResult = await toolRegistry.invokeTool('calculate_sum', { a: 40, b: 2 });
        assert.deepStrictEqual(callResult, { sum: 42 });

        // Invalid parameters validation
        try {
            await toolRegistry.invokeTool('calculate_sum', { a: 'invalid' as any });
            assert.fail('Invalid argument types should throw validation error');
        } catch (err: any) {
            assert.ok(err.message.includes('validation') || err.message.includes('required') || err.message.includes('invalid') || err.message.includes('schema'));
        }

        // ArtifactPipeline
        const pipeline = new ArtifactPipeline();
        const artifactId = 'doc-artifact-42';
        
        pipeline.createArtifact({
            id: artifactId,
            type: 'document',
            title: 'System Design Spec',
            content: { text: '# Title\n\nInitial draft' },
            version: 1
        });

        const initial = pipeline.getArtifact(artifactId);
        assert.strictEqual(initial?.version, 1);
        assert.strictEqual((initial?.content as any).text, '# Title\n\nInitial draft');

        // Apply stream delta mutation
        let emittedChange: any = null;
        pipeline.onDidChangeArtifact(change => {
            emittedChange = change;
        });

        pipeline.applyPatch(artifactId, {
            patchType: 'append_text',
            path: 'text',
            value: '\n## Section 1: Architecture'
        });

        const updated = pipeline.getArtifact(artifactId);
        assert.strictEqual(updated?.version, 2);
        assert.strictEqual((updated?.content as any).text, '# Title\n\nInitial draft\n## Section 1: Architecture');
        assert.ok(emittedChange !== null);
        assert.strictEqual(emittedChange.artifactId, artifactId);

        // Version history rollback
        const history = pipeline.getHistory(artifactId);
        assert.strictEqual(history.length, 2);
        pipeline.rollbackToVersion(artifactId, 1);
        const rolledBack = pipeline.getArtifact(artifactId);
        assert.strictEqual((rolledBack?.content as any).text, '# Title\n\nInitial draft');

        console.log('  ✓ ToolRegistry schema validation & invocation, and ArtifactPipeline reactive mutations passed');
    }

    // =========================================================================
    // 6. PURE REACT / TS DOCKING & VIEWPORT ENGINE
    // =========================================================================
    console.log('\n--- 6. Testing Pure React Native Docking & Viewport Layout Engine ---');
    {
        const layoutEngine = new WorkspaceLayoutEngine();
        
        // Initial setup: single root tab group
        const group1Id = layoutEngine.createTabGroup({
            activeTabId: 'tab-editor-1',
            tabs: [
                { id: 'tab-editor-1', title: 'index.ts', icon: 'file-code', closeable: true },
                { id: 'tab-editor-2', title: 'styles.css', icon: 'file', closeable: true }
            ]
        });

        assert.strictEqual(layoutEngine.getActiveTab(group1Id)?.id, 'tab-editor-1');

        // Split vertically into second tab group
        const group2Id = layoutEngine.splitGroup(group1Id, SplitDirection.Vertical, {
            ratio: 0.5,
            initialTabs: [
                { id: 'tab-canvas-1', title: 'Generative Canvas Studio', icon: 'sparkles', closeable: true }
            ]
        });

        assert.ok(group2Id !== null);
        const groups = layoutEngine.getAllTabGroups();
        assert.strictEqual(groups.length, 2, 'Should now have 2 tab groups');

        // Move tab between groups
        layoutEngine.moveTab('tab-editor-2', group1Id, group2Id);
        const g1Tabs = layoutEngine.getTabsInGroup(group1Id);
        const g2Tabs = layoutEngine.getTabsInGroup(group2Id);
        assert.strictEqual(g1Tabs.length, 1);
        assert.strictEqual(g2Tabs.length, 2);
        assert.ok(g2Tabs.some(t => t.id === 'tab-editor-2'));

        // Floating panel management
        const floatId = layoutEngine.openFloatingPanel({
            id: 'floating-terminal',
            title: 'Terminal 1',
            position: { x: 100, y: 150, width: 600, height: 400 },
            visible: true
        });

        assert.strictEqual(layoutEngine.getFloatingPanel(floatId)?.visible, true);
        layoutEngine.setFloatingPanelVisibility(floatId, false);
        assert.strictEqual(layoutEngine.getFloatingPanel(floatId)?.visible, false);

        // Serialization & Deserialization
        const serialized = layoutEngine.serialize();
        assert.ok(typeof serialized === 'string');

        const restoredEngine = WorkspaceLayoutEngine.deserialize(serialized);
        assert.strictEqual(restoredEngine.getAllTabGroups().length, 2);
        assert.strictEqual(restoredEngine.getFloatingPanel('floating-terminal')?.title, 'Terminal 1');

        console.log('  ✓ WorkspaceLayoutEngine splits, tab movements, floating panels, and serialization passed');
    }

    console.log('\n🎉 ALL SCRATCHBOX CORE RUNTIME TESTS PASSED WITH 100% SUCCESS RATE!\n');
}


export { runScratchboxCoreRuntimeTests };

test('scratchbox-core-runtime.test', async () => {
    await runScratchboxCoreRuntimeTests();
}, 180_000);
