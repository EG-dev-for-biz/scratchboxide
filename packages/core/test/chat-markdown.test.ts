import { test } from 'vitest';
import * as assert from 'assert';
import {
    parseMarkdownBlocks,
    cleanMessageTextSmart,
    tokenizeCode
} from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { ChatMessage } from '../src/browser/generative-canvas/canvas-types';

async function runChatMarkdownTests() {
    console.log('🧪 Running Chat Stream, Markdown & Code Block Test Suite...');

    // Test 1: Code Block Extraction with Language Detection
    const sampleAssistantMessage = `Here is how you configure the Gemini 3.8 Flash subagent:

\`\`\`typescript
import { GoogleGenAI } from '@google/genai';

export async function createAssistantStream(prompt: string): Promise<string> {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await client.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt
    });
    return response.text;
}
\`\`\`

You can execute this with \`ts-node script.ts\` in your terminal.`;

    const blocks = parseMarkdownBlocks(sampleAssistantMessage);
    assert.strictEqual(blocks.length, 3, 'Message should be parsed into 3 distinct blocks (paragraph, code, paragraph)');
    
    assert.strictEqual(blocks[0].type, 'paragraph');
    if (blocks[0].type === 'paragraph') {
        assert.ok(blocks[0].content.includes('Here is how you configure'));
    }

    assert.strictEqual(blocks[1].type, 'code');
    if (blocks[1].type === 'code') {
        assert.strictEqual(blocks[1].language, 'typescript', 'Language tag should be typescript');
        assert.ok(blocks[1].content.includes("export async function createAssistantStream"), 'Code content should contain function definition');
        assert.ok(!blocks[1].content.startsWith('```'), 'Code block content should not include surrounding backticks');
    }

    assert.strictEqual(blocks[2].type, 'paragraph');
    if (blocks[2].type === 'paragraph') {
        assert.ok(blocks[2].content.includes('ts-node script.ts'), 'Trailing paragraph should contain inline command');
    }
    console.log('  ✓ Test 1 Passed: Code blocks and surrounding text accurately parsed with language metadata');

    // Test 2: Multi-Language and Fallback Language Support
    const multiLangMarkdown = `\`\`\`python
def calculate_metrics(values):
    return {"sum": sum(values), "avg": sum(values) / len(values)}
\`\`\`

\`\`\`bash
curl -X POST http://127.0.0.1:3000/api/v1/generate
\`\`\`

\`\`\`
raw unlabelled configuration text
\`\`\``;

    const multiBlocks = parseMarkdownBlocks(multiLangMarkdown);
    assert.strictEqual(multiBlocks.length, 3);
    assert.strictEqual(multiBlocks[0].type === 'code' ? multiBlocks[0].language : '', 'python');
    assert.strictEqual(multiBlocks[1].type === 'code' ? multiBlocks[1].language : '', 'bash');
    assert.strictEqual(multiBlocks[2].type === 'code' ? multiBlocks[2].language : '', 'plaintext');
    console.log('  ✓ Test 2 Passed: Multi-language code blocks and fallback language tags verified');

    // Test 3: Markdown Headings, Lists, and Blockquotes
    const richMarkdown = `# System Architecture

Here are the primary components:
- High Reasoning LLM Core
- MCP Streaming Gateway
- Canvas Primitives (N8N, Document, Kanban)

> Note: All communication channels are end-to-end encrypted.`;

    const richBlocks = parseMarkdownBlocks(richMarkdown);
    assert.ok(richBlocks.some(b => b.type === 'heading' && b.level === 1 && b.content === 'System Architecture'), 'Header level 1 found');
    assert.ok(richBlocks.some(b => b.type === 'list' && b.items.length === 3), 'Bullet list with 3 items found');
    assert.ok(richBlocks.some(b => b.type === 'blockquote' && b.content.includes('Note: All communication channels')), 'Blockquote found');
    console.log('  ✓ Test 3 Passed: Headings, bullet lists, and blockquotes parsed accurately');

    // Test 4: Syntax Tokenizer for IDE-Grade Code Highlighting
    const sampleCode = `const apiKey: string = "secret_123";
// Comment line
function execute(val: number) {
    if (val > 10) return true;
    return false;
}`;
    const tokens = tokenizeCode(sampleCode, 'typescript');
    assert.ok(tokens.length > 0, 'Tokens array must not be empty');
    assert.ok(tokens.some(t => t.type === 'keyword' && (t.text === 'const' || t.text === 'function' || t.text === 'return')), 'Keyword tokens recognized');
    assert.ok(tokens.some(t => t.type === 'string' && t.text.includes('secret_123')), 'String literals recognized');
    assert.ok(tokens.some(t => t.type === 'comment' && t.text.includes('Comment line')), 'Comments recognized');
    assert.ok(tokens.some(t => t.type === 'number' && t.text === '10'), 'Number literals recognized');
    console.log('  ✓ Test 4 Passed: Code syntax tokenizer correctly identifies keywords, strings, comments, and numbers');

    // Test 5: Smart Message Cleaning (preserving code blocks while stripping artifact json payloads)
    const rawArtifactResponse = `I've synthesized the architecture flow for you below:

\`\`\`json
{
  "type": "node-graph",
  "data": {
    "title": "Auth Architecture",
    "nodes": []
  }
}
\`\`\`

You can edit this graph directly or use the snippet below:

\`\`\`typescript
export const config = { timeout: 5000 };
\`\`\``;

    const cleaned = cleanMessageTextSmart(rawArtifactResponse, {
        id: 'art-1',
        type: 'node-graph',
        title: 'Auth Architecture',
        summary: 'Architecture flow',
        version: 1,
        createdAt: 'Now',
        data: { title: 'Auth Architecture', nodes: [], edges: [] }
    });

    assert.ok(!cleaned.includes('"type": "node-graph"'), 'Artifact JSON payload block should be stripped');
    assert.ok(cleaned.includes('export const config = { timeout: 5000 };'), 'Actual typescript code block must be preserved');
    assert.ok(cleaned.includes("I've synthesized the architecture flow for you below:"), 'Conversational text preserved');
    console.log('  ✓ Test 5 Passed: Smart cleaner removes artifact payload JSONs while strictly preserving code blocks');

    // Test 5b: Document Generation Raw JSON Payload & Poem Stripping
    const rawDocumentAiResponse = `Here is the comprehensive product specification and architectural poem you requested:

\`\`\`json
{
  "id": "art-doc-987",
  "type": "markdown-document",
  "title": "Quantum Computing Roadmap",
  "data": {
    "title": "Quantum Computing Roadmap",
    "subtitle": "Qubit simulation & fault tolerance",
    "sections": [
      {
        "id": "sec-1",
        "type": "heading",
        "level": 1,
        "content": "1. Overview"
      },
      {
        "id": "sec-2",
        "type": "paragraph",
        "content": "A whisper in silicon, where superposition blooms."
      }
    ]
  }
}
\`\`\`

Let me know if you would like me to expand any of the roadmap phases!`;

    const cleanedDocMsg = cleanMessageTextSmart(rawDocumentAiResponse, {
        id: 'art-doc-987',
        type: 'markdown-document',
        title: 'Quantum Computing Roadmap',
        summary: 'Roadmap specification',
        version: 1,
        createdAt: 'Now',
        data: { title: 'Quantum Computing Roadmap', sections: [] }
    });

    assert.ok(!cleanedDocMsg.includes('"type": "markdown-document"'), 'Document JSON payload must be thoroughly stripped');
    assert.ok(!cleanedDocMsg.includes('art-doc-987'), 'Artifact id must be stripped from chat body');
    assert.ok(cleanedDocMsg.includes('Here is the comprehensive product specification and architectural poem you requested:'), 'Leading conversation text preserved');
    assert.ok(cleanedDocMsg.includes('Let me know if you would like me to expand any of the roadmap phases!'), 'Trailing conversation text preserved');

    // Also verify parseMarkdownBlocks does not emit a code block for document artifact json
    const parsedDocBlocks = parseMarkdownBlocks(rawDocumentAiResponse);
    assert.strictEqual(parsedDocBlocks.filter(b => b.type === 'code').length, 0, 'No code block should be emitted for artifact JSON payload');
    
    // Test 5c: Strip "Here's the JSON for your Scratchbox canvas:" preamble and raw JSON block
    const promptWithJsonPreamble = `Connected to Studio AI Engine with Thinking active...This is a fantastic topic! A paper on 1776 offers a rich historical narrative. I've prepared a structured document for you, complete with an executive summary, key historical points, a location-based image, and a primary source callout, all formatted as a Scratchbox markdown document.

Here's the JSON for your Scratchbox canvas:

\`\`\`json
{
  "id": "art-1776-paper",
  "type": "markdown-document",
  "title": "The Pivotal Year: 1776 and the Birth of a Nation",
  "summary": "This document explores the critical events, philosophical underpinnings, and key..."
}
\`\`\``;

    const cleanedPreambleMsg = cleanMessageTextSmart(promptWithJsonPreamble, {
        id: 'art-1776-paper',
        type: 'markdown-document',
        title: 'The Pivotal Year: 1776 and the Birth of a Nation',
        summary: 'Paper',
        version: 1,
        createdAt: 'Now',
        data: { title: '1776', sections: [] }
    });

    assert.ok(!cleanedPreambleMsg.includes('Connected to Studio AI Engine'), 'Preamble connected string should be stripped');
    assert.ok(!cleanedPreambleMsg.includes("Here's the JSON for your Scratchbox canvas:"), 'JSON lead-in sentence should be stripped');
    assert.ok(!cleanedPreambleMsg.includes('"id": "art-1776-paper"'), 'JSON body must be completely stripped');
    assert.ok(cleanedPreambleMsg.includes('This is a fantastic topic! A paper on 1776 offers a rich historical narrative.'), 'Conversational narrative text must be cleanly retained');

    console.log('  ✓ Test 5b & 5c Passed: Document generation raw JSON code boxes and JSON preambles thoroughly stripped from chat history');

    // Test 6: High-Fidelity Multimedia & Maps Grounding Message Structure
    const imageMessage: ChatMessage = {
        id: 'msg-img',
        sender: 'assistant',
        text: 'Here is the rendered image.',
        timestamp: '3:18 PM',
        imageContent: 'data:image/png;base64,iVBORw0KGgo...',
        imagesContent: ['data:image/png;base64,iVBORw0KGgo...']
    };
    assert.strictEqual(imageMessage.imageContent, 'data:image/png;base64,iVBORw0KGgo...');
    assert.ok(imageMessage.imagesContent && imageMessage.imagesContent.length === 1);

    const audioMessage: ChatMessage = {
        id: 'msg-aud',
        sender: 'assistant',
        text: 'Listen to this narrator.',
        timestamp: '3:18 PM',
        audioContent: 'data:audio/wav;base64,UklGR...'
    };
    assert.strictEqual(audioMessage.audioContent, 'data:audio/wav;base64,UklGR...');

    const videoMessage: ChatMessage = {
        id: 'msg-vid',
        sender: 'assistant',
        text: 'Check out the drone flight.',
        timestamp: '3:18 PM',
        videoContent: 'https://example.com/cinematic-drone.mp4'
    };
    assert.strictEqual(videoMessage.videoContent, 'https://example.com/cinematic-drone.mp4');

    const mapMessage: ChatMessage = {
        id: 'msg-map',
        sender: 'assistant',
        text: 'Coordinates are locked in.',
        timestamp: '3:18 PM',
        mapContent: {
            lat: 37.7749,
            lng: -122.4194,
            placeName: 'Scratchbox Headquarters',
            address: '100 Innovation Way, San Francisco, CA'
        }
    };
    assert.strictEqual(mapMessage.mapContent?.lat, 37.7749);
    assert.strictEqual(mapMessage.mapContent?.lng, -122.4194);
    assert.strictEqual(mapMessage.mapContent?.placeName, 'Scratchbox Headquarters');
    assert.strictEqual(mapMessage.mapContent?.address, '100 Innovation Way, San Francisco, CA');

    console.log('  ✓ Test 6 Passed: ChatMessage media payload types and interface properties validated successfully');

    // Test 7: Executive Document Markdown Parsing & Clean Rendering
    const executiveDocumentMarkdown = `# The Profound Significance of 1776: Liberty, Revolution, and Democratic Thought

The year 1776 stands as the foundational crucible of the American Republic and modern democratic thought.

Beyond the immediate theater of war, 1776 redefined the relationship between citizen and state.

## Key Turning Points & Chronology

> [!NOTE] Primary Source Insight
Thomas Paine's Common Sense galvanized mass popular support.

| Date | Milestone | Significance |
| --- | --- | --- |
| July 4, 1776 | Declaration of Independence | Formal resolution severing political ties |
| Dec 25, 1776 | Crossing of the Delaware | Resurrected colonial morale at Trenton |

- [x] Sovereign statehood declared
- [ ] Continental fiscal infrastructure established

\`\`\`typescript
const year = 1776;
\`\`\`
`;

    const parsedExecBlocks = parseMarkdownBlocks(executiveDocumentMarkdown);
    assert.ok(parsedExecBlocks.some(b => b.type === 'heading' && b.content.includes('1776')), 'Document main title heading parsed');
    assert.ok(parsedExecBlocks.some(b => b.type === 'heading' && b.level === 2 && b.content.includes('Chronology')), 'Chronology level 2 heading parsed');
    assert.ok(parsedExecBlocks.some(b => b.type === 'code' && b.language === 'typescript'), 'TypeScript snippet block parsed');
    console.log('  ✓ Test 7 Passed: Executive document multi-section markdown parsed cleanly');

    console.log('\n🎉 ALL CHAT MARKDOWN & CODE BLOCK TESTS PASSED SUCCESSFULLY!');
}

test('chat-markdown.test', async () => {
    await runChatMarkdownTests();
}, 180_000);
