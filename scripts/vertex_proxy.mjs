#!/usr/bin/env node
/**
 * Vertex AI <-> OpenAI Compatibility Bridge for Scratchbox IDE
 * 
 * Allows Scratchbox IDE and external coding clients to use your Google Cloud Vertex AI account
 * as an OpenAI-compatible endpoint for coding models:
 *   - gemini-2.5-pro (High-reasoning architecture & complex refactoring)
 *   - gemini-2.5-flash (Ultra-low latency streaming coding assistant)
 *   - claude-3-7-sonnet@20250219 (Anthropic on Vertex AI Model Garden)
 *   - claude-3-5-sonnet-v2@20241022 (Anthropic on Vertex AI Model Garden)
 *   - codestral-2501 (Mistral Code on Vertex AI Model Garden)
 * 
 * Client Configuration:
 *   1. Settings -> Models:
 *      - Check/enable "Override OpenAI Base URL"
 *      - Base URL: http://127.0.0.1:4000/v1
 *      - OpenAI API Key: the proxy token (env VERTEX_PROXY_TOKEN; if unset, a random
 *        token is generated at startup and printed to the console)
 *   2. Under Models:
 *      - Click "+ Add model" and enter: "gemini-2.5-flash" or "gemini-2.5-pro" or "claude-3-7-sonnet"
 *   3. Select the model in Chat, Composer, or Inline Edit!
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from 'google-auth-library';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvCredentials() {
  const envPath = path.resolve(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return null;
  const envText = fs.readFileSync(envPath, 'utf8');
  let credsStr = '';
  let location = 'us-central1';

  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('GOOGLE_SERVICE_ACCOUNT_JSON=')) {
      credsStr = trimmed.slice('GOOGLE_SERVICE_ACCOUNT_JSON='.length).trim();
      if ((credsStr.startsWith("'") && credsStr.endsWith("'")) || (credsStr.startsWith('"') && credsStr.endsWith('"'))) {
        credsStr = credsStr.slice(1, -1);
      }
    }
    if (trimmed.startsWith('GOOGLE_CLOUD_LOCATION=')) {
      location = trimmed.slice('GOOGLE_CLOUD_LOCATION='.length).trim().replace(/^["']|["']$/g, '');
    }
  }

  if (!credsStr) return null;
  try {
    const creds = JSON.parse(credsStr);
    if (creds.private_key) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }
    return { creds, location };
  } catch (err) {
    console.error('[VertexProxy] Error parsing GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
    return null;
  }
}

const config = loadEnvCredentials();
if (!config) {
  console.error('[VertexProxy] ❌ Failed to load Google credentials from .env');
  process.exit(1);
}

const auth = new GoogleAuth({
  credentials: config.creds,
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  cachedToken = tokenRes.token;
  tokenExpiresAt = now + 50 * 60 * 1000;
  return cachedToken;
}

function openAiToGeminiContents(messages) {
  let systemInstruction = '';
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += (systemInstruction ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map(p => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
      }
      contents.push({ role, parts: [{ text }] });
    }
  }

  // Ensure alternating turns
  const sanitizedContents = [];
  let lastRole = null;
  for (const c of contents) {
    if (c.role === lastRole && sanitizedContents.length > 0) {
      sanitizedContents[sanitizedContents.length - 1].parts[0].text += '\n\n' + c.parts[0].text;
    } else {
      sanitizedContents.push(c);
      lastRole = c.role;
    }
  }

  return { systemInstruction, contents: sanitizedContents };
}

function openAiToAnthropicMessages(messages) {
  let system = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      let content = msg.content;
      if (typeof content !== 'string') {
        content = JSON.stringify(content);
      }
      anthropicMessages.push({ role, content });
    }
  }

  return { system, messages: anthropicMessages };
}

const PORT = parseInt(process.env.VERTEX_PROXY_PORT || '4000', 10);

// Shared-secret auth: every request must present this token (Authorization: Bearer <token>
// or x-api-key). Without it any website / local process could spend the user's GCP quota.
const PROXY_TOKEN_FROM_ENV = Boolean(process.env.VERTEX_PROXY_TOKEN && process.env.VERTEX_PROXY_TOKEN.trim());
const PROXY_TOKEN = PROXY_TOKEN_FROM_ENV
  ? process.env.VERTEX_PROXY_TOKEN.trim()
  : `sk-vertex-${crypto.randomBytes(24).toString('hex')}`;
const PROXY_TOKEN_BUF = Buffer.from(PROXY_TOKEN, 'utf8');

// Vertex model IDs only: letters, digits, '.', '_', '@', '-'. No '/', '?', '#', ':' or '..'
// so the value cannot redirect the bearer-authenticated request to another aiplatform path.
const MODEL_ID_PATTERN = /^[A-Za-z0-9._@-]+$/;
function isValidModelId(model) {
  return typeof model === 'string' && model.length <= 128 && MODEL_ID_PATTERN.test(model) && !model.includes('..');
}

function isAuthorized(req) {
  const authHeader = String(req.headers['authorization'] || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const presented = bearer || String(req.headers['x-api-key'] || '').trim();
  if (!presented) return false;
  const presentedBuf = Buffer.from(presented, 'utf8');
  return presentedBuf.length === PROXY_TOKEN_BUF.length && crypto.timingSafeEqual(presentedBuf, PROXY_TOKEN_BUF);
}

const server = http.createServer(async (req, res) => {
  // No CORS headers: browsers on other origins cannot call this proxy (Authorization forces a preflight).
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized: missing or invalid proxy token' } }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // GET /v1/models (Used by model picker & test connection)
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    const models = [
      { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google-vertex' },
      { id: 'gemini-2.5-pro', object: 'model', owned_by: 'google-vertex' },
      { id: 'claude-3-7-sonnet@20250219', object: 'model', owned_by: 'anthropic-vertex' },
      { id: 'claude-3-5-sonnet-v2@20241022', object: 'model', owned_by: 'anthropic-vertex' },
      { id: 'codestral-2501', object: 'model', owned_by: 'mistral-vertex' }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
    return;
  }

  // POST /v1/chat/completions
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const rawModel = payload.model || 'gemini-2.5-flash';
        if (!isValidModelId(rawModel)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid model id: must match /^[A-Za-z0-9._@-]+$/' } }));
          return;
        }
        const stream = payload.stream !== false;
        const token = await getAccessToken();
        const projectId = config.creds.project_id;
        const location = config.location;

        console.log(`[VertexProxy] 📥 Incoming request: model="${rawModel}" stream=${stream}`);

        // Route: Anthropic Claude on Vertex AI Model Garden
        if (rawModel.toLowerCase().includes('claude')) {
          let vertexModel = rawModel;
          if (vertexModel === 'claude-3-7-sonnet' || vertexModel === 'claude-3.7-sonnet') {
            vertexModel = 'claude-3-7-sonnet@20250219';
          } else if (vertexModel === 'claude-3-5-sonnet' || vertexModel === 'claude-3.5-sonnet') {
            vertexModel = 'claude-3-5-sonnet-v2@20241022';
          }

          const { system, messages } = openAiToAnthropicMessages(payload.messages || []);
          const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(vertexModel)}:${stream ? 'streamRawPredict' : 'rawPredict'}`;

          const vertexPayload = {
            anthropic_version: 'vertex-2023-10-16',
            messages,
            max_tokens: payload.max_tokens || 4096,
            temperature: payload.temperature ?? 0.2,
            stream
          };
          if (system) {
            vertexPayload.system = system;
          }

          const vertexRes = await fetch(vertexUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(vertexPayload)
          });

          if (!vertexRes.ok) {
            const errText = await vertexRes.text();
            console.error(`[VertexProxy] ❌ Claude error (${vertexRes.status}):`, errText);
            res.writeHead(vertexRes.status, { 'Content-Type': 'application/json' });
            res.end(errText);
            return;
          }

          if (!stream) {
            const anthropicJson = await vertexRes.json();
            const text = anthropicJson.content?.[0]?.text || '';
            const openAiRes = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: rawModel,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop'
              }]
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiRes));
            return;
          }

          // Stream Claude SSE to OpenAI SSE
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const reader = vertexRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim();
                if (!dataStr) continue;
                try {
                  const ev = JSON.parse(dataStr);
                  if (ev.type === 'content_block_delta' && ev.delta?.text) {
                    const chunk = {
                      id: `chatcmpl-${Date.now()}`,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: rawModel,
                      choices: [{
                        index: 0,
                        delta: { content: ev.delta.text },
                        finish_reason: null
                      }]
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  }
                } catch {}
              }
            }
          }

          res.write(`data: {"id":"chatcmpl-end","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Route: Google Gemini on Vertex AI
        let geminiModel = 'gemini-2.5-flash';
        if (rawModel.includes('pro') || rawModel === 'gemini-2.5-pro' || rawModel.includes('thinking')) {
          geminiModel = 'gemini-2.5-pro';
        }

        const { systemInstruction, contents } = openAiToGeminiContents(payload.messages || []);
        const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${geminiModel}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

        // Thinking budget: disable for flash coding speed; allow moderate for pro
        const thinkingBudget = geminiModel === 'gemini-2.5-flash' ? 0 : (payload.thinking_budget ?? 2048);

        const vertexPayload = {
          contents,
          generationConfig: {
            temperature: payload.temperature ?? 0.2,
            maxOutputTokens: payload.max_tokens || 8192,
            thinkingConfig: { thinkingBudget }
          }
        };
        if (systemInstruction) {
          vertexPayload.systemInstruction = {
            role: 'system',
            parts: [{ text: systemInstruction }]
          };
        }

        const vertexRes = await fetch(vertexUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(vertexPayload)
        });

        if (!vertexRes.ok) {
          const errText = await vertexRes.text();
          console.error(`[VertexProxy] ❌ Gemini Vertex error (${vertexRes.status}):`, errText);
          res.writeHead(vertexRes.status, { 'Content-Type': 'application/json' });
          res.end(errText);
          return;
        }

        if (!stream) {
          const geminiJson = await vertexRes.json();
          const text = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const openAiRes = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: rawModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: 'stop'
            }]
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(openAiRes));
          return;
        }

        // Stream Gemini SSE to OpenAI SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const reader = vertexRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('data: ')) {
              const dataStr = trimmedLine.slice(6).trim();
              if (!dataStr) continue;
              try {
                const ev = JSON.parse(dataStr);
                const text = ev.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  const chunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: rawModel,
                    choices: [{
                      index: 0,
                      delta: { content: text },
                      finish_reason: null
                    }]
                  };
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              } catch {}
            }
          }
        }

        res.write(`data: {"id":"chatcmpl-end","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

      } catch (err) {
        console.error('[VertexProxy] Handler error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n================================================================`);
  console.log(`🚀 Vertex AI OpenAI Bridge running on http://127.0.0.1:${PORT}`);
  console.log(`   Project ID: ${config.creds.project_id}`);
  console.log(`   Region:     ${config.location}`);
  console.log(`----------------------------------------------------------------`);
  console.log(`Configure in Scratchbox IDE or compatible client:`);
  console.log(`   1. Settings -> Models:`);
  console.log(`      - Enable "Override OpenAI Base URL"`);
  console.log(`      - Set to: http://127.0.0.1:${PORT}/v1`);
  if (PROXY_TOKEN_FROM_ENV) {
    console.log(`      - Set OpenAI API Key: <value of VERTEX_PROXY_TOKEN>`);
  } else {
    console.log(`      - Set OpenAI API Key: ${PROXY_TOKEN}`);
    console.log(`        (generated for this run; set VERTEX_PROXY_TOKEN to pin it)`);
  }
  console.log(`   2. Under Models list:`);
  console.log(`      - Add: "gemini-2.5-flash"  (Ultra-fast coding & inline edits)`);
  console.log(`      - Add: "gemini-2.5-pro"    (Deep reasoning & complex code)`);
  console.log(`      - Add: "claude-3-7-sonnet" (When enabled in Vertex Model Garden)`);
  console.log(`================================================================\n`);
});
