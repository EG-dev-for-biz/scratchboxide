import { test } from 'vitest';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeminiService, DEFAULT_CHAT_MODEL, DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODELS } from '../src/node/gemini-service';
import { GeminiClient } from '../src/node/gemini/gemini-client';

const SERVICE_PATH = path.join(__dirname, '../src/node/gemini-service.ts');
const GEMINI_DIR = path.join(__dirname, '../src/node/gemini');

/**
 * Snapshot of every method on `GeminiService.prototype` captured before the god-object split.
 * Public API consumers (desktop-app/server/app.ts, deep-write/*, long-running-agent-service,
 * subagent-pool-service) and tests that reach private members via `(service as any)` rely on these.
 */
const PUBLIC_METHODS_BEFORE_SPLIT = [
    'audit3DSceneMultiAngle',
    'buildContents',
    'buildSubagentInstruction',
    'buildSystemInstructionPrompt',
    'compilePrompt',
    'executeLensListBindings',
    'executeLensProject',
    'executeLensSync',
    'executeLensUnproject',
    'executeSubagentTask',
    'executeSwarmDAG',
    'extractCodeSandboxArtifact',
    'extractDocumentTitle',
    'formatContents',
    'generateArtifact',
    'getCodebaseLensController',
    'getCodebaseLensRegistry',
    'getContextGraphService',
    'getDiffMemoryService',
    'getLspFeedbackService',
    'getMemoriesService',
    'getPatternEngine',
    'getPoolMetrics',
    'getSandboxService',
    'getStatus',
    'getSubagentModelCandidates',
    'getSubagentPoolService',
    'getVisualVerificationService',
    'markdownStringToSections',
    'pingMcpServer',
    'run3DVisualSelfCorrectionLoop',
    'saveCredentialsDirectly',
    'startDeepResearchSession',
    'streamGenerate',
    'synthesizeSpeech',
    'verifyVisual'
];

/** Private members that existing tests reach through `(service as any).<name>(...)`. */
const PRIVATE_MEMBERS_REACHED_BY_TESTS = [
    'buildToolDeclarations',
    'synthesizeMcpExecution',
    'buildSystemInstruction',
    'parseOrSynthesizeArtifact'
];

const EXPECTED_MODULES = [
    'gemini-client.ts',
    'tool-registry.ts',
    'artifact-synthesis.ts',
    'lens-bridge.ts',
    'mcp-bridge.ts',
    'swarm-bridge.ts',
    'streaming.ts'
];

test('GeminiService facade keeps every pre-split public method', () => {
    const prototypeNames = new Set(Object.getOwnPropertyNames(GeminiService.prototype));
    for (const name of [...PUBLIC_METHODS_BEFORE_SPLIT, ...PRIVATE_MEMBERS_REACHED_BY_TESTS]) {
        assert.ok(prototypeNames.has(name), `GeminiService.prototype must still define ${name}`);
        assert.strictEqual(typeof (GeminiService.prototype as any)[name], 'function', `${name} must be a method`);
    }

    // Re-exported constants that other modules import from gemini-service.
    assert.strictEqual(typeof DEFAULT_GEMINI_MODEL, 'string');
    assert.ok(Array.isArray(FALLBACK_GEMINI_MODELS) && FALLBACK_GEMINI_MODELS.length > 0);

    // Tests set these auth fields directly on the instance; the facade must honour those writes.
    const service = new GeminiService();
    const fakeAuth = { getClient: async () => ({ getAccessToken: async () => ({ token: 't' }) }) };
    (service as any).auth = fakeAuth;
    (service as any).cachedProjectId = 'proj-facade';
    assert.strictEqual((service as any).auth, fakeAuth);
    assert.strictEqual((service as any).cachedProjectId, 'proj-facade');
});

test('gemini-service.ts is a thin facade and gemini/ holds the extracted modules', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf-8');
    const lineCount = source.split('\n').length;
    assert.ok(lineCount < 1300, `gemini-service.ts must stay under 1300 lines (currently ${lineCount})`);

    assert.ok(fs.existsSync(GEMINI_DIR), 'packages/core/src/node/gemini/ must exist');
    const present = new Set(fs.readdirSync(GEMINI_DIR));
    for (const mod of EXPECTED_MODULES) {
        assert.ok(present.has(mod), `gemini/${mod} must exist`);
    }
});

test('modules under gemini/ never import the facade (no runtime import cycle)', () => {
    const files = fs.readdirSync(GEMINI_DIR).filter(f => f.endsWith('.ts'));
    assert.ok(files.length >= EXPECTED_MODULES.length);
    for (const file of files) {
        const src = fs.readFileSync(path.join(GEMINI_DIR, file), 'utf-8');
        assert.ok(
            !/from\s+['"]\.\.\/gemini-service['"]/.test(src) && !/require\(\s*['"]\.\.\/gemini-service['"]\s*\)/.test(src),
            `gemini/${file} must not import '../gemini-service'`
        );
    }
});

test('initAuth no longer probes personal Downloads paths', () => {
    const clientPath = path.join(GEMINI_DIR, 'gemini-client.ts');
    const src = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf-8') : fs.readFileSync(SERVICE_PATH, 'utf-8');
    assert.ok(!/Downloads\//.test(src), 'service-account discovery must not probe ~/Downloads');
    assert.ok(src.includes('GOOGLE_APPLICATION_CREDENTIALS'));
    assert.ok(src.includes('.scratchbox/service-account.json'));
    assert.ok(src.includes('.scratchbox-ide/service-account.json'));
});

test('the chat agent defaults to gemini-3.8-flash; callers that name no model keep the flagship', () => {
    // user decision 2026-11-03: the main agent on gemini-3.8-flash for speed
    assert.strictEqual(DEFAULT_CHAT_MODEL, 'gemini-3.8-flash');
    const service = new GeminiService();
    assert.strictEqual(service.getActiveModel(), DEFAULT_CHAT_MODEL);
    assert.strictEqual((service as any).client.getModelCandidates()[0], DEFAULT_CHAT_MODEL);
    // a model the workspace chose in Settings > Models still leads
    assert.strictEqual((service as any).client.getModelCandidates('gemini-4-argon')[0], 'gemini-4-argon');
    // every other client (vision chains, judges, reference builds) is unchanged
    assert.strictEqual(DEFAULT_GEMINI_MODEL, 'gemini-4-argon');
    assert.strictEqual(new GeminiClient().preferredModel, DEFAULT_GEMINI_MODEL);
});
