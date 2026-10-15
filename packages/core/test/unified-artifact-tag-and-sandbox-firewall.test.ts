import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    extractScratchboxPrimitiveTag,
    parseOrSynthesizeArtifact
} from '../src/node/gemini/artifact-synthesis';
import { cleanMessageTextSmart } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { buildSandboxSrcDoc } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import { LiveCodeSandboxData } from '../src/browser/generative-canvas/canvas-types';

test('Unified Artifact Tag Architecture, Unbounded Micro-Apps, and Iframe Firewall Isolation', async () => {
    console.log('🧪 Starting Unified Artifact Tag & Sandbox Firewall Test Suite...\n');

    // =========================================================================
    // SECTION 1: Unified Artifact Tag (<scratchboxPrimitive>) Extraction
    // =========================================================================
    console.log('--- SECTION 1: Unified Tag Extraction ---');

    // 1.1 Extract tag with full attributes
    const fullTagText = `Here is your interactive application:
<scratchboxPrimitive type="live-code-sandbox" title="Gravity Orbit Sim" summary="Interactive Newtonian physics sandbox" version="2">
export default function App() {
  return <div>Gravity Sim</div>;
}
</scratchboxPrimitive>
Enjoy exploring the orbital simulation!`;

    const extractedFull = extractScratchboxPrimitiveTag(fullTagText);
    assert.strictEqual(extractedFull.matched, true);
    assert.strictEqual(extractedFull.type, 'live-code-sandbox');
    assert.strictEqual(extractedFull.title, 'Gravity Orbit Sim');
    assert.strictEqual(extractedFull.summary, 'Interactive Newtonian physics sandbox');
    assert.strictEqual(extractedFull.version, 2);
    assert.ok(extractedFull.rawPayload.includes('export default function App()'));
    console.log('  ✓ 1.1 Full attribute tag correctly extracted and parsed');

    // 1.2 Type alias normalization
    const aliasTag1 = extractScratchboxPrimitiveTag('<scratchboxPrimitive type="sandbox" title="Mini App">Code</scratchboxPrimitive>');
    assert.strictEqual(aliasTag1.type, 'live-code-sandbox');

    const aliasTag2 = extractScratchboxPrimitiveTag('<scratchboxPrimitive type="document" title="Spec"># Document</scratchboxPrimitive>');
    assert.strictEqual(aliasTag2.type, 'markdown-document');

    const aliasTag3 = extractScratchboxPrimitiveTag('<scratchboxPrimitive type="timeline" title="Video Project">Timeline</scratchboxPrimitive>');
    assert.strictEqual(aliasTag3.type, 'video-timeline');
    console.log('  ✓ 1.2 Type alias normalization verified for sandbox, document, and timeline');

    // 1.3 Unclosed tag (streaming tail)
    const streamingTag = `<scratchboxPrimitive type="live-code-sandbox" title="Live Streaming Preview">
import React from 'react';
export default function App() {`;

    const extractedStreaming = extractScratchboxPrimitiveTag(streamingTag);
    assert.strictEqual(extractedStreaming.matched, true);
    assert.strictEqual(extractedStreaming.type, 'live-code-sandbox');
    assert.strictEqual(extractedStreaming.title, 'Live Streaming Preview');
    assert.ok(extractedStreaming.rawPayload.includes('import React'));
    console.log('  ✓ 1.3 Streaming unclosed tag parsed gracefully without errors');

    // =========================================================================
    // SECTION 2: End-to-End Artifact Synthesis via <scratchboxPrimitive>
    // =========================================================================
    console.log('\n--- SECTION 2: Artifact Synthesis via Canonical Tag ---');

    // 2.1 Live-code-sandbox with raw TSX code
    const mockRequest = { prompt: 'Make a particle burst sandbox' };
    const rawTsxModelOutput = `I have designed a high-velocity particle burst system for you.

<scratchboxPrimitive type="live-code-sandbox" title="Particle Burst System" summary="High performance particle accelerator">
\`\`\`tsx
import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';

export default function App() {
  const [particles, setParticles] = useState(100);
  return (
    <div className="p-8 bg-zinc-950 text-white">
      <h1 className="text-xl font-bold flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-amber-400" /> Particle Chamber
      </h1>
      <p>Active particles: {particles}</p>
    </div>
  );
}
\`\`\`
</scratchboxPrimitive>

Let me know if you would like to tune the emission rate!`;

    const synthSandboxArtifact = parseOrSynthesizeArtifact('Make a particle burst sandbox', rawTsxModelOutput, mockRequest as any, []);
    assert.strictEqual(synthSandboxArtifact.type, 'live-code-sandbox');
    assert.strictEqual(synthSandboxArtifact.title, 'Particle Burst System');
    assert.strictEqual(synthSandboxArtifact.summary, 'High performance particle accelerator');
    
    const sandboxData = synthSandboxArtifact.data as LiveCodeSandboxData;
    assert.strictEqual(sandboxData.template, 'react');
    assert.strictEqual(sandboxData.viewMode, 'preview');
    assert.ok(sandboxData.files.length >= 1);
    assert.strictEqual(sandboxData.files[0].name, 'App.tsx');
    assert.ok(sandboxData.files[0].content.includes('Particle Chamber'));
    assert.ok(sandboxData.dependencies['lucide-react']);
    console.log('  ✓ 2.1 Raw TSX in <scratchboxPrimitive> synthesized directly into live-code-sandbox');

    // 2.2 Markdown Document with Markdown body
    const docModelOutput = `<scratchboxPrimitive type="markdown-document" title="Autonomous Agent Topology" summary="Architectural blueprint">
# Autonomous Agent Topology
## Abstract
This document defines the agent graph and orchestration protocol.
## Component Architecture
- Agent Node
- Supervisor Controller
</scratchboxPrimitive>`;

    const synthDocArtifact = parseOrSynthesizeArtifact('Design agent architecture spec', docModelOutput, { prompt: 'Design agent architecture spec' } as any, []);
    assert.strictEqual(synthDocArtifact.type, 'markdown-document');
    assert.strictEqual(synthDocArtifact.title, 'Autonomous Agent Topology');
    assert.ok(synthDocArtifact.data.sections.length >= 1);
    console.log('  ✓ 2.2 Raw Markdown in <scratchboxPrimitive> synthesized directly into markdown-document');

    // 2.3 JSON payload inside <scratchboxPrimitive>
    const jsonModelOutput = `<scratchboxPrimitive type="3d-scene" title="Deep Space Nebula">
\`\`\`json
{
  "title": "Deep Space Nebula",
  "camera": { "fov": 55, "position": [0, 10, 30] },
  "environment": { "skybox": "space-nebula" }
}
\`\`\`
</scratchboxPrimitive>`;

    const synthJsonArtifact = parseOrSynthesizeArtifact('Render deep space nebula', jsonModelOutput, { prompt: 'Render deep space nebula' } as any, []);
    assert.strictEqual(synthJsonArtifact.type, '3d-scene');
    assert.strictEqual(synthJsonArtifact.title, 'Deep Space Nebula');
    assert.deepStrictEqual(synthJsonArtifact.data.camera, { fov: 55, position: [0, 10, 30] });
    // A first scene sent in the tag is a clay first pass like one sent as an envelope: the model's sky is dropped
    // unless the prompt asks for one.
    assert.strictEqual(synthJsonArtifact.data.renderMode, 'clay');
    assert.strictEqual(synthJsonArtifact.data.environment.skybox, 'studio');
    console.log('  ✓ 2.3 JSON payload inside <scratchboxPrimitive> parsed and synthesized correctly');

    // =========================================================================
    // SECTION 3: Chat Markdown Sanitization (Zero Disclaimer Leaks)
    // =========================================================================
    console.log('\n--- SECTION 3: Chat Markdown Sanitization ---');

    const assistantChatWithTag = `Here is your real-time physics simulation running live on the canvas.

<scratchboxPrimitive type="live-code-sandbox" title="Fluid Dynamics Sim" summary="Real-time Navier-Stokes simulation">
import React from 'react';
export default function Fluid() { return <div>Sim</div>; }
</scratchboxPrimitive>

You can interact with the fluid particles using your mouse cursor or trackpad.`;

    const cleanedChatText = cleanMessageTextSmart(assistantChatWithTag);
    assert.ok(cleanedChatText.includes('Here is your real-time physics simulation running live on the canvas.'));
    assert.ok(cleanedChatText.includes('You can interact with the fluid particles using your mouse cursor or trackpad.'));
    assert.ok(!cleanedChatText.includes('<scratchboxPrimitive'));
    assert.ok(!cleanedChatText.includes('</scratchboxPrimitive>'));
    assert.ok(!cleanedChatText.includes('Fluid Dynamics Sim'));
    assert.ok(!cleanedChatText.includes('Navier-Stokes'));
    console.log('  ✓ 3.1 <scratchboxPrimitive> tags stripped completely from user chat bubble');

    const streamingChatWithTag = `Generating your live audio synthesizer...
<scratchboxPrimitive type="live-code-sandbox" title="Synth" summary="Audio app">
const audioCtx = new AudioContext();`;

    const cleanedStreamingChat = cleanMessageTextSmart(streamingChatWithTag);
    assert.strictEqual(cleanedStreamingChat, 'Generating your live audio synthesizer...');
    assert.ok(!cleanedStreamingChat.includes('<scratchboxPrimitive'));
    console.log('  ✓ 3.2 Unclosed streaming <scratchboxPrimitive> stripped completely from user chat bubble');

    // =========================================================================
    // SECTION 4: A prose reply mounts nothing (no micro-app template is written from prompt keywords)
    // =========================================================================
    console.log('\n--- SECTION 4: Prose replies mount no template app ---');
    for (const userPrompt of [
        'build an orbital gravity simulator',
        'create a modular web audio synthesizer',
        'retro space breakout arcade game',
        'sorting algorithm visualizer'
    ]) {
        const artifact = parseOrSynthesizeArtifact(userPrompt, 'Sure! Let me set that up for you.', { prompt: userPrompt } as any, []);
        assert.strictEqual(artifact, undefined, `Prompt "${userPrompt}" must not get a template live-code-sandbox`);
    }
    console.log('  ✓ 4.1 Micro-app prompts answered in prose leave the canvas as it is');

    // =========================================================================
    // SECTION 5: Iframe Firewall & Content Security Policy Isolation
    // =========================================================================
    console.log('\n--- SECTION 5: Iframe Firewall & CSP Security Audit ---');

    // 5.1 CSP in React Template
    const sampleReactData: LiveCodeSandboxData = {
        title: 'Security Test',
        template: 'react',
        viewMode: 'preview',
        files: [
            { id: 'app', name: 'App.tsx', language: 'react', content: 'export default function App() { return <h1>Secured</h1>; }' }
        ]
    };
    const reactSrcDoc = buildSandboxSrcDoc(sampleReactData);
    assert.ok(reactSrcDoc.includes('<meta http-equiv="Content-Security-Policy"'), 'React srcDoc must contain CSP meta tag');
    assert.ok(reactSrcDoc.includes('https://cdn.jsdelivr.net'), 'CSP must whitelist jsdelivr CDN');
    assert.ok(reactSrcDoc.includes('https://esm.sh'), 'CSP must whitelist esm.sh');
    assert.ok(reactSrcDoc.includes('https://unpkg.com'), 'CSP must whitelist unpkg CDN');
    assert.ok(reactSrcDoc.includes('https://cdn.tailwindcss.com'), 'CSP must whitelist Tailwind CDN');
    console.log('  ✓ 5.1 React sandbox srcDoc contains hardened Content Security Policy');

    // 5.2 CSP in Python Template
    const samplePythonData: LiveCodeSandboxData = {
        title: 'Python Test',
        template: 'python',
        viewMode: 'preview',
        files: [
            { id: 'main', name: 'main.py', language: 'python', content: 'print(42)' }
        ]
    };
    const pySrcDoc = buildSandboxSrcDoc(samplePythonData);
    assert.ok(pySrcDoc.includes('<meta http-equiv="Content-Security-Policy"'), 'Python srcDoc must contain CSP meta tag');
    console.log('  ✓ 5.2 Python sandbox srcDoc contains hardened Content Security Policy');

    // 5.3 Verify iframe sandbox attribute in LiveCodeSandboxPrimitive.tsx
    const liveSandboxFile = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx');
    const liveSandboxSource = fs.readFileSync(liveSandboxFile, 'utf8');

    // Must have sandbox attribute
    assert.ok(liveSandboxSource.includes('sandbox="allow-scripts allow-modals allow-forms allow-popups"'), 'Iframe must enforce isolated origin sandbox');
    // Must NOT contain allow-same-origin in LiveCodeSandboxPrimitive iframe
    assert.ok(!liveSandboxSource.includes('sandbox="allow-scripts allow-same-origin'), 'Sandbox iframe must NOT allow-same-origin to prevent host compromise');
    console.log('  ✓ 5.3 LiveCodeSandboxPrimitive.tsx verified: allow-same-origin removed; iframe firewall active');

    console.log('\n🎉 ALL 18 VERIFICATION CHECKS PASSED!\n');
});
