/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { MarkdownDocumentData, MarkdownSection, getActiveUserName } from './canvas-types';
import { synthesizeContextualNanoBananaPrompt } from './nano-banana-service';

export type DocumentTheme =
    | '1776-revolution'
    | 'history-general'
    | 'auth-zerotrust-security'
    | 'cloud-distributed-systems'
    | 'ai-machine-learning'
    | 'product-strategy-roadmap'
    | 'scientific-research'
    | 'general-architecture';

/**
 * Detect semantic theme from document title, prompt, and section context.
 */
export function detectDocumentTheme(promptOrTitle: string, extraContext?: string): DocumentTheme {
    const combined = `${promptOrTitle} ${extraContext || ''}`.toLowerCase();

    if (/1776|declaration of independence|american revolution|founding fathers|george washington|thomas jefferson|independence hall|continental congress|common sense|thomas paine|lexington|concord|bunker hill|delaware crossing|trenton/i.test(combined)) {
        return '1776-revolution';
    }
    if (/roman|renaissance|civil war|wwii|world war|ancient greece|medieval|treaty|monarchy|constitution|histor(y|ical)/i.test(combined)) {
        return 'history-general';
    }
    if (/auth(entication)?|oauth|jwt|security|identity|zero[- ]trust|fido2|passkey|webauthn|pkce|rbac|crypto(graphy)?|saml|openid|oidc|credential/i.test(combined)) {
        return 'auth-zerotrust-security';
    }
    if (/transformer|diffusion|attention mechanism|llm|neural network|machine learning|deep learning|vision model|gemini|gpt|subagent|embedding|nlp|inference/i.test(combined)) {
        return 'ai-machine-learning';
    }
    if (/microservice|distributed system|kubernetes|docker|cloud fabric|grpc|graphql|api gateway|redis|kafka|database|postgres|serverless|mesh|envoy/i.test(combined)) {
        return 'cloud-distributed-systems';
    }
    if (/roadmap|product strategy|business plan|executive proposal|sprint plan|okr|kpi|q[1-4]|milestone roadmap|launch plan/i.test(combined)) {
        return 'product-strategy-roadmap';
    }
    if (/quantum|biology|genomics|crispr|physics|neuroscience|biotech|chemistry|particle/i.test(combined)) {
        return 'scientific-research';
    }
    return 'general-architecture';
}

/**
 * Extract an evocative, specific document title from prompt context, avoiding generic strings.
 */
export function extractDocumentTitleFromPrompt(prompt: string, fallback: string = 'Project Specification & Strategic Notes'): string {
    const cleanPrompt = prompt
        .replace(/^[\s\W]*(write|create|generate|draft|build|make)?\s*(a|an|the)?\s*(extensive|comprehensive|detailed|new)?\s*(document|spec|specification|overview|notes|guide|report|proposal)?\s*(about|for|on|of|regarding)?\s*/i, '')
        .replace(/for section ["'].*?["']/i, '')
        .replace(/in document ["'](.*?)["']/i, '$1')
        .replace(/[?.!]+$/, '')
        .trim();

    if (cleanPrompt.length > 2 && cleanPrompt !== 'selected content') {
        return cleanPrompt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 75);
    }

    return fallback && fallback !== 'Markdown Document' ? fallback : 'Project Specification & Strategic Notes';
}

/**
 * SVG Generator for 1776 Revolutionary Timeline Diagram
 */
export function generate1776SvgTimeline(): string {
    return `<svg viewBox="0 0 880 240" fill="none" xmlns="http://www.w3.org/2000/svg" class="sb-4d-svg-graphic">
  <defs>
    <linearGradient id="trackGrad" x1="40" y1="120" x2="840" y2="120" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.8"/>
      <stop offset="25%" stop-color="#6366f1" stop-opacity="0.9"/>
      <stop offset="50%" stop-color="#ec4899" stop-opacity="0.9"/>
      <stop offset="75%" stop-color="#f59e0b" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0.9"/>
    </linearGradient>
    <filter id="glow1776" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background Canvas Card -->
  <rect x="0" y="0" width="880" height="240" rx="14" fill="rgba(15, 23, 42, 0.4)" stroke="rgba(255, 255, 255, 0.08)" />

  <!-- Timeline Flow Line -->
  <path d="M 60 120 L 820 120" stroke="url(#trackGrad)" stroke-width="4" stroke-linecap="round" filter="url(#glow1776)"/>

  <!-- Milestone 1: Jan 1776 -->
  <g class="sb-svg-node" transform="translate(80, 120)">
    <circle r="14" fill="#1e293b" stroke="#3b82f6" stroke-width="3" />
    <circle r="5" fill="#3b82f6" />
    <line x1="0" y1="-14" x2="0" y2="-45" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="3 3"/>
    <rect x="-65" y="-95" width="130" height="50" rx="8" fill="rgba(30, 41, 59, 0.85)" stroke="rgba(59, 130, 246, 0.4)"/>
    <text x="0" y="-77" fill="#93c5fd" font-size="10" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">JANUARY 1776</text>
    <text x="0" y="-58" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Common Sense</text>
    <text x="0" y="32" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Thomas Paine</text>
  </g>

  <!-- Milestone 2: June 1776 -->
  <g class="sb-svg-node" transform="translate(260, 120)">
    <circle r="14" fill="#1e293b" stroke="#6366f1" stroke-width="3" />
    <circle r="5" fill="#6366f1" />
    <line x1="0" y1="14" x2="0" y2="45" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="3 3"/>
    <rect x="-70" y="45" width="140" height="50" rx="8" fill="rgba(30, 41, 59, 0.85)" stroke="rgba(99, 102, 241, 0.4)"/>
    <text x="0" y="65" fill="#c7d2fe" font-size="10" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">JUNE 1776</text>
    <text x="0" y="82" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Lee Resolution</text>
    <text x="0" y="-22" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Committee of Five</text>
  </g>

  <!-- Milestone 3: July 4, 1776 (Focal Point) -->
  <g class="sb-svg-node" transform="translate(440, 120)">
    <circle r="18" fill="#1e293b" stroke="#ec4899" stroke-width="3.5" filter="url(#glow1776)" />
    <circle r="7" fill="#ec4899" />
    <line x1="0" y1="-18" x2="0" y2="-50" stroke="#ec4899" stroke-width="2"/>
    <rect x="-85" y="-105" width="170" height="55" rx="10" fill="rgba(30, 41, 59, 0.95)" stroke="#ec4899" stroke-width="1.5"/>
    <text x="0" y="-85" fill="#f472b6" font-size="10" font-weight="800" text-anchor="middle" letter-spacing="0.5" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">JULY 4, 1776</text>
    <text x="0" y="-68" fill="#ffffff" font-size="12" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Declaration Ratified</text>
    <text x="0" y="32" fill="#cbd5e1" font-size="10" font-weight="500" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Independence Hall</text>
  </g>

  <!-- Milestone 4: August 1776 -->
  <g class="sb-svg-node" transform="translate(620, 120)">
    <circle r="14" fill="#1e293b" stroke="#f59e0b" stroke-width="3" />
    <circle r="5" fill="#f59e0b" />
    <line x1="0" y1="14" x2="0" y2="45" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3 3"/>
    <rect x="-70" y="45" width="140" height="50" rx="8" fill="rgba(30, 41, 59, 0.85)" stroke="rgba(245, 158, 11, 0.4)"/>
    <text x="0" y="65" fill="#fde68a" font-size="10" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">AUGUST 1776</text>
    <text x="0" y="82" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Battle of Long Island</text>
    <text x="0" y="-22" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Tactical Army Defense</text>
  </g>

  <!-- Milestone 5: Dec 25–26, 1776 -->
  <g class="sb-svg-node" transform="translate(800, 120)">
    <circle r="15" fill="#1e293b" stroke="#10b981" stroke-width="3" filter="url(#glow1776)" />
    <circle r="6" fill="#10b981" />
    <line x1="0" y1="-15" x2="0" y2="-45" stroke="#10b981" stroke-width="1.5" stroke-dasharray="3 3"/>
    <rect x="-75" y="-95" width="145" height="50" rx="8" fill="rgba(30, 41, 59, 0.85)" stroke="rgba(16, 185, 129, 0.4)"/>
    <text x="0" y="-77" fill="#6ee7b7" font-size="10" font-weight="700" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">DECEMBER 25–26</text>
    <text x="0" y="-58" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Delaware Crossing</text>
    <text x="0" y="32" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif">Trenton Counteroffensive</text>
  </g>
</svg>`;
}

/**
 * SVG Generator for Technical Zero-Trust Authentication Architecture
 */
export function generateAuthArchitectureSvg(): string {
    return `<svg viewBox="0 0 880 230" fill="none" xmlns="http://www.w3.org/2000/svg" class="sb-4d-svg-graphic">
  <defs>
    <linearGradient id="authEdgeGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="880" height="230" rx="14" fill="rgba(15, 23, 42, 0.4)" stroke="rgba(255, 255, 255, 0.08)" />

  <!-- Node 1: Client / WebAuthn -->
  <g transform="translate(30, 40)">
    <rect width="140" height="150" rx="10" fill="rgba(30, 41, 59, 0.8)" stroke="#38bdf8" stroke-width="1.5"/>
    <rect x="12" y="14" width="28" height="28" rx="6" fill="rgba(56, 189, 248, 0.2)"/>
    <text x="26" y="32" fill="#38bdf8" font-size="14" text-anchor="middle">📱</text>
    <text x="12" y="65" fill="#f8fafc" font-size="13" font-weight="700" font-family="-apple-system, sans-serif">Client Surface</text>
    <text x="12" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• FIDO2 / Passkey</text>
    <text x="12" y="102" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• PKCE SHA-256</text>
    <text x="12" y="120" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• SameSite Cookies</text>
    <rect x="12" y="130" width="116" height="12" rx="3" fill="rgba(56, 189, 248, 0.15)"/>
    <text x="70" y="139" fill="#38bdf8" font-size="8" font-weight="600" text-anchor="middle">SECURE CONTEXT</text>
  </g>

  <!-- Arrow 1 -> 2 -->
  <path d="M 175 115 L 235 115" stroke="#38bdf8" stroke-width="2" stroke-dasharray="4 3"/>
  <polygon points="235,115 227,110 227,120" fill="#38bdf8"/>
  <text x="205" y="105" fill="#94a3b8" font-size="9" text-anchor="middle">mTLS 1.3</text>

  <!-- Node 2: Envoy Edge Proxy -->
  <g transform="translate(240, 40)">
    <rect width="150" height="150" rx="10" fill="rgba(30, 41, 59, 0.8)" stroke="#818cf8" stroke-width="1.5"/>
    <rect x="12" y="14" width="28" height="28" rx="6" fill="rgba(129, 140, 248, 0.2)"/>
    <text x="26" y="32" fill="#818cf8" font-size="14" text-anchor="middle">🛡️</text>
    <text x="12" y="65" fill="#f8fafc" font-size="13" font-weight="700" font-family="-apple-system, sans-serif">Edge Envoy Gateway</text>
    <text x="12" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Rate Limiter Bucket</text>
    <text x="12" y="102" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• WAF Anomaly Filter</text>
    <text x="12" y="120" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• TLS Termination</text>
    <rect x="12" y="130" width="126" height="12" rx="3" fill="rgba(129, 140, 248, 0.15)"/>
    <text x="75" y="139" fill="#818cf8" font-size="8" font-weight="600" text-anchor="middle">&lt; 2ms LATENCY</text>
  </g>

  <!-- Arrow 2 -> 3 -->
  <path d="M 395 115 L 455 115" stroke="#818cf8" stroke-width="2" stroke-dasharray="4 3"/>
  <polygon points="455,115 447,110 447,120" fill="#818cf8"/>
  <text x="425" y="105" fill="#94a3b8" font-size="9" text-anchor="middle">Auth Req</text>

  <!-- Node 3: Zero-Trust IdP -->
  <g transform="translate(460, 40)">
    <rect width="160" height="150" rx="10" fill="rgba(30, 41, 59, 0.8)" stroke="#a855f7" stroke-width="1.5"/>
    <rect x="12" y="14" width="28" height="28" rx="6" fill="rgba(168, 85, 247, 0.2)"/>
    <text x="26" y="32" fill="#a855f7" font-size="14" text-anchor="middle">🔑</text>
    <text x="12" y="65" fill="#f8fafc" font-size="13" font-weight="700" font-family="-apple-system, sans-serif">Zero-Trust IdP Core</text>
    <text x="12" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Ed25519 Token Mint</text>
    <text x="12" y="102" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• JWKS Key Auto-Rotate</text>
    <text x="12" y="120" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Session Revocation</text>
    <rect x="12" y="130" width="136" height="12" rx="3" fill="rgba(168, 85, 247, 0.15)"/>
    <text x="80" y="139" fill="#a855f7" font-size="8" font-weight="600" text-anchor="middle">OIDC 2.1 CONFORMANT</text>
  </g>

  <!-- Arrow 3 -> 4 -->
  <path d="M 625 115 L 685 115" stroke="#a855f7" stroke-width="2" stroke-dasharray="4 3"/>
  <polygon points="685,115 677,110 677,120" fill="#a855f7"/>
  <text x="655" y="105" fill="#94a3b8" font-size="9" text-anchor="middle">JWT Claims</text>

  <!-- Node 4: Microservice Cluster -->
  <g transform="translate(690, 40)">
    <rect width="160" height="150" rx="10" fill="rgba(30, 41, 59, 0.8)" stroke="#10b981" stroke-width="1.5"/>
    <rect x="12" y="14" width="28" height="28" rx="6" fill="rgba(16, 185, 129, 0.2)"/>
    <text x="26" y="32" fill="#10b981" font-size="14" text-anchor="middle">⚡</text>
    <text x="12" y="65" fill="#f8fafc" font-size="13" font-weight="700" font-family="-apple-system, sans-serif">Protected Services</text>
    <text x="12" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Local Sig Verification</text>
    <text x="12" y="102" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Fine-grained RBAC</text>
    <text x="12" y="120" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Zero DB Round-Trip</text>
    <rect x="12" y="130" width="136" height="12" rx="3" fill="rgba(16, 185, 129, 0.15)"/>
    <text x="80" y="139" fill="#10b981" font-size="8" font-weight="600" text-anchor="middle">SUB-25MS VERIFY</text>
  </g>
</svg>`;
}

/**
 * SVG Generator for AI & Neural Reasoning Pipeline
 */
export function generateAiArchitectureSvg(title: string): string {
    return `<svg viewBox="0 0 880 230" fill="none" xmlns="http://www.w3.org/2000/svg" class="sb-4d-svg-graphic">
  <rect x="0" y="0" width="880" height="230" rx="14" fill="rgba(15, 23, 42, 0.4)" stroke="rgba(255, 255, 255, 0.08)" />

  <!-- Layer 1: Multi-Modal Ingestion -->
  <g transform="translate(30, 40)">
    <rect width="180" height="150" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="14" y="32" fill="#38bdf8" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">1. MULTI-MODAL INGESTION</text>
    <text x="14" y="60" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Prompt &amp; Media Mesh</text>
    <text x="14" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Text / Audio / Video Tokens</text>
    <text x="14" y="103" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Multimodal Vector Embedding</text>
    <text x="14" y="121" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Semantic Context Slicing</text>
  </g>

  <path d="M 215 115 L 255 115" stroke="#38bdf8" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="255,115 247,110 247,120" fill="#38bdf8"/>

  <!-- Layer 2: Transformer Attention Mesh -->
  <g transform="translate(260, 40)">
    <rect width="180" height="150" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#818cf8" stroke-width="1.5"/>
    <text x="14" y="32" fill="#818cf8" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">2. ATTENTION ENGINE</text>
    <text x="14" y="60" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Gemini 3.7 Flash Core</text>
    <text x="14" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Multi-Head Flash Attention</text>
    <text x="14" y="103" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Adaptive Thinking Budget</text>
    <text x="14" y="121" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Subagent DAG Routing</text>
  </g>

  <path d="M 445 115 L 485 115" stroke="#818cf8" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="485,115 477,110 477,120" fill="#818cf8"/>

  <!-- Layer 3: Tool & MCP Execution -->
  <g transform="translate(490, 40)">
    <rect width="180" height="150" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#ec4899" stroke-width="1.5"/>
    <text x="14" y="32" fill="#ec4899" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">3. MCP TOOL REASONING</text>
    <text x="14" y="60" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Live Tool Mesh Execution</text>
    <text x="14" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Grounded Maps &amp; Visuals</text>
    <text x="14" y="103" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• GitHub / Stripe Integrations</text>
    <text x="14" y="121" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Realtime Validation Feedback</text>
  </g>

  <path d="M 675 115 L 715 115" stroke="#ec4899" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="715,115 707,110 707,120" fill="#ec4899"/>

  <!-- Layer 4: Multi-Modal Visual Stage -->
  <g transform="translate(720, 40)">
    <rect width="130" height="150" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#10b981" stroke-width="1.5"/>
    <text x="12" y="32" fill="#10b981" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">4. VISUAL STAGE</text>
    <text x="12" y="60" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Reactive Canvas</text>
    <text x="12" y="85" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• 60fps Live Stream</text>
    <text x="12" y="103" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Multi-Modal Sync</text>
    <text x="12" y="121" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• ACID Cache Snap</text>
  </g>
</svg>`;
}

/**
 * SVG Generator for General System Architecture & Flow
 */
export function generateGenericArchitectureSvg(title: string): string {
    return `<svg viewBox="0 0 880 220" fill="none" xmlns="http://www.w3.org/2000/svg" class="sb-doc-svg-graphic sb-4d-svg-graphic">
  <rect x="0" y="0" width="880" height="220" rx="14" fill="rgba(15, 23, 42, 0.4)" stroke="rgba(255, 255, 255, 0.08)" />

  <!-- Layer 1 -->
  <g transform="translate(40, 45)">
    <rect width="160" height="130" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#3b82f6" stroke-width="1.5"/>
    <text x="16" y="35" fill="#3b82f6" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">1. INGESTION &amp; TRIGGERS</text>
    <text x="16" y="65" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Client &amp; API Layer</text>
    <text x="16" y="90" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• WebSocket &amp; SSE Stream</text>
    <text x="16" y="110" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Event Bus Pipeline</text>
  </g>

  <path d="M 205 110 L 255 110" stroke="#3b82f6" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="255,110 247,105 247,115" fill="#3b82f6"/>

  <!-- Layer 2 -->
  <g transform="translate(260, 45)">
    <rect width="170" height="130" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#8b5cf6" stroke-width="1.5"/>
    <text x="16" y="35" fill="#8b5cf6" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">2. ORCHESTRATION</text>
    <text x="16" y="65" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Execution Engine</text>
    <text x="16" y="90" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• State Machine &amp; Guardrails</text>
    <text x="16" y="110" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Synthesis Compiler</text>
  </g>

  <path d="M 435 110 L 485 110" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="485,110 477,105 477,115" fill="#8b5cf6"/>

  <!-- Layer 3 -->
  <g transform="translate(490, 45)">
    <rect width="170" height="130" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#ec4899" stroke-width="1.5"/>
    <text x="16" y="35" fill="#ec4899" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">3. REASONING CORE</text>
    <text x="16" y="65" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">AI &amp; MCP Tool Mesh</text>
    <text x="16" y="90" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Gemini 3.7 Flash Engine</text>
    <text x="16" y="110" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Live MCP Protocols</text>
  </g>

  <path d="M 665 110 L 715 110" stroke="#ec4899" stroke-width="2" stroke-dasharray="3 3"/>
  <polygon points="715,110 707,105 707,115" fill="#ec4899"/>

  <!-- Layer 4 -->
  <g transform="translate(720, 45)">
    <rect width="130" height="130" rx="10" fill="rgba(30, 41, 59, 0.85)" stroke="#10b981" stroke-width="1.5"/>
    <text x="14" y="35" fill="#10b981" font-size="11" font-weight="700" font-family="-apple-system, sans-serif">4. PERSISTENCE</text>
    <text x="14" y="65" fill="#f8fafc" font-size="13" font-weight="600" font-family="-apple-system, sans-serif">Live Visual Stage</text>
    <text x="14" y="90" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• ACID State Cache</text>
    <text x="14" y="110" fill="#94a3b8" font-size="10" font-family="-apple-system, sans-serif">• Realtime Canvas</text>
  </g>
</svg>`;
}

/**
 * Generate deeply motivated Location & Spatial Anchor section based on document topic.
 */
export function generateMotivatedLocationSection(theme: DocumentTheme, contextText?: string, title?: string): MarkdownSection {
    const id = `sec-loc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (theme === '1776-revolution') {
        // Authentically motivated colonial historical location
        return {
            id,
            type: 'location-image',
            locationName: 'Independence Hall (Pennsylvania State House), Philadelphia',
            coordinates: { lat: 39.9489, lng: -75.1500 },
            caption: 'The Assembly Room where the Second Continental Congress debated and unanimously adopted the Declaration of Independence in July 1776.',
            visualPrompt: 'Historical authentic Georgian colonial red brick facade of Independence Hall in Philadelphia during the summer of 1776, cobblestone streets, horse carriage, soft golden morning light, high-fidelity period architecture.',
            imageUrl: 'https://images.unsplash.com/photo-1575881875475-31024b156660?auto=format&fit=crop&w=1600&q=85',
            mapZoom: 16,
            alt: 'Independence Hall Assembly Room Philadelphia 1776',
            attribution: 'Historical Landmark • Philadelphia, Pennsylvania',
            dateTag: 'July 1776 • Philadelphia'
        };
    }

    if (theme === 'auth-zerotrust-security') {
        return {
            id,
            type: 'location-image',
            locationName: 'Global Edge PoP & Zero-Trust Cloud Mesh (Ashburn Corridor)',
            coordinates: { lat: 39.0438, lng: -77.4874 },
            caption: 'Primary distributed edge computing hub executing sub-25ms asymmetric Ed25519 token verification and FIDO2 Passkey biometric ceremonies.',
            visualPrompt: 'High-tech server facility with glowing cyan and blue fiber optic connections, topological network map overlay, dark modern data center infrastructure.',
            imageUrl: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=1600&q=85',
            mapZoom: 13,
            alt: 'Zero-Trust Global Edge Mesh Map',
            attribution: 'Cloud Edge Infrastructure • Ashburn Corridor',
            dateTag: 'Global Edge Mesh'
        };
    }

    if (theme === 'ai-machine-learning') {
        return {
            id,
            type: 'location-image',
            locationName: 'AI Systems Laboratory & High-Density GPU Cluster (Cambridge MA)',
            coordinates: { lat: 42.3619, lng: -71.0906 },
            caption: 'Accelerated computing research cluster training and serving multi-modal Gemini 3.7 reasoning and autonomous agent subpools.',
            visualPrompt: 'Advanced neural research computing laboratory with high-density GPU supercluster, glowing fiber arrays, and holographic architectural monitors.',
            imageUrl: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1600&q=85',
            mapZoom: 14,
            alt: 'AI Systems Laboratory & Compute Cluster',
            attribution: 'Accelerated Compute Facility • Cambridge, MA',
            dateTag: 'AI Systems Laboratory'
        };
    }

    if (theme === 'product-strategy-roadmap') {
        return {
            id,
            type: 'location-image',
            locationName: 'Global Innovation & Product Engineering Studio (Cupertino CA)',
            coordinates: { lat: 37.3346, lng: -122.0090 },
            caption: 'Central product development studio coordinating cross-functional design sprints, architecture reviews, and production release trains.',
            visualPrompt: 'Minimalist glass architectural studio bathed in natural daylight, high-resolution collaborative screens, clean premium Cupertino-grade aesthetics.',
            imageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1600&q=85',
            mapZoom: 15,
            alt: 'Innovation & Product Studio Hub',
            attribution: 'Product Engineering Studio • Cupertino, CA',
            dateTag: 'Design Studio'
        };
    }

    // Default / Cloud Distributed Systems
    return {
        id,
        type: 'location-image',
        locationName: 'Primary Operational Center & Cloud Infrastructure (San Francisco CA)',
        coordinates: { lat: 37.7749, lng: -122.4194 },
        caption: `Operational infrastructure context and distributed deployment topology supporting ${title || 'Project Specification'}.`,
        visualPrompt: 'Modern high-tech engineering command center with real-time distributed telemetry displays and modern architectural lighting.',
        imageUrl: 'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?auto=format&fit=crop&w=1600&q=85',
        mapZoom: 13,
        alt: 'Operational Infrastructure Anchor',
        attribution: 'Operational Infrastructure • San Francisco, CA',
        dateTag: 'Core Infrastructure'
    };
}

/**
 * Generate deeply motivated Editorial Image section (curated & Nano Banana synthesizable) based on document topic.
 */
export function generateMotivatedEditorialImageSection(theme: DocumentTheme, contextText?: string, title?: string): MarkdownSection {
    const id = `sec-img-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const styleId = theme === '1776-revolution' ? 'oil-painting' : theme === 'auth-zerotrust-security' ? 'architectural' : theme === 'ai-machine-learning' ? 'neural-ai' : 'modern-editorial';

    const defaultTitle = theme === '1776-revolution' ? "Washington's Crossing of the Delaware River (1776)" : undefined;
    const synth = synthesizeContextualNanoBananaPrompt({
        docTitle: title || 'Comprehensive Specification Document',
        sectionTitle: contextText ? (contextText.slice(0, 80)) : defaultTitle,
        sectionContent: contextText || (theme === '1776-revolution' ? 'General George Washington leads 2,400 Continental Army soldiers across the ice-choked Delaware River on Christmas night 1776 in a decisive surprise counteroffensive at Trenton.' : undefined),
        theme,
        styleId
    });

    return {
        id,
        type: 'editorial-image',
        imageTitle: synth.imageTitle || (theme === '1776-revolution' ? "Washington's Crossing of the Delaware (1776)" : `Architecture & System Execution: ${title || 'Specification'}`),
        caption: synth.caption || 'High-fidelity visual synthesis illustrating key domain principles and architectural workflows.',
        description: synth.caption || 'High-fidelity visual synthesis illustrating key domain principles and architectural workflows.',
        imageUrl: synth.curatedImageUrl,
        thumbnailUrl: synth.curatedImageUrl,
        attribution: synth.attribution,
        dateTag: synth.dateTag || 'Nano Banana Visual Synthesis',
        stylePreset: synth.styleLabel,
        aspectRatio: '16:9',
        visualPrompt: synth.prompt
    };
}

/**
 * Generate deeply motivated Video & Walkthrough Reconstruction section based on document topic.
 * (Preserved with rich editorial image attributes for backwards compatibility).
 */
export function generateMotivatedVideoSection(theme: DocumentTheme, contextText?: string, title?: string): MarkdownSection {
    const id = `sec-vid-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const styleId = theme === '1776-revolution' ? 'cinematic-film' : theme === 'auth-zerotrust-security' ? 'architectural' : theme === 'ai-machine-learning' ? 'neural-ai' : 'modern-editorial';

    const defaultTitle = theme === '1776-revolution' ? 'Reenactment of the Declaration of Independence Signing' : undefined;
    const synth = synthesizeContextualNanoBananaPrompt({
        docTitle: title || 'Comprehensive Specification Document',
        sectionTitle: contextText ? contextText.slice(0, 80) : defaultTitle,
        sectionContent: contextText || (theme === '1776-revolution' ? 'A conceptual video simulating the atmosphere and key moments of the Second Continental Congress as delegates debate and ultimately sign the Declaration of Independence.' : undefined),
        theme,
        styleId
    });

    return {
        id,
        type: 'video',
        videoTitle: synth.imageTitle || (theme === '1776-revolution' ? 'Reenactment of the Declaration of Independence Signing' : `System Walkthrough: ${title || 'Specification'}`),
        caption: synth.caption || 'Historical visual reconstruction simulating key foundational moments and debates.',
        description: synth.caption || 'Historical visual reconstruction simulating key foundational moments and debates.',
        imageUrl: synth.curatedImageUrl,
        thumbnailUrl: synth.curatedImageUrl,
        attribution: synth.attribution,
        dateTag: synth.dateTag || 'Temporal Visual Reconstruction',
        stylePreset: synth.styleLabel,
        aspectRatio: '16:9',
        visualPrompt: synth.prompt,
        duration: theme === '1776-revolution' ? '03:42' : theme === 'auth-zerotrust-security' ? '02:15' : theme === 'ai-machine-learning' ? '02:40' : '02:30',
        timelineEvents: theme === '1776-revolution' ? [
            { time: '00:00', label: "Opening Debates in Assembly Room", description: 'Delegates from the thirteen colonies debate the Lee Resolution under intense summer heat.' },
            { time: '01:15', label: 'Committee of Five Draft Presentation', description: 'Thomas Jefferson, Benjamin Franklin, and John Adams present the revised parchment draft.' },
            { time: '02:30', label: 'Unanimous Resolution Vote', description: 'Twelve colonies vote in favor of independence, with New York abstaining then endorsing.' },
            { time: '03:15', label: 'Ceremonial Signing by John Hancock', description: 'President John Hancock places the prominent first signature onto the engrossed parchment.' }
        ] : theme === 'auth-zerotrust-security' ? [
            { time: '00:00', label: 'PKCE Challenge Generation', description: 'Client generates high-entropy code verifier and computes SHA-256 code challenge.' },
            { time: '00:45', label: 'Biometric Passkey Signing', description: 'Device Secure Enclave prompts Touch ID / Face ID and signs challenge with private key.' },
            { time: '01:30', label: 'Authorization Code Issue', description: 'Zero-Trust IdP verifies attestation and issues single-use authorization code.' },
            { time: '02:00', label: 'Ed25519 JWT Exchange', description: 'IdP validates code verifier and issues asymmetric dual-tokens via HttpOnly cookies.' }
        ] : [
            { time: '00:00', label: 'System Initialization', description: 'Bootstrapping runtime contexts and dependency validation.' },
            { time: '00:50', label: 'Pipeline Execution', description: 'Real-time multi-modal streaming and artifact generation.' },
            { time: '01:40', label: 'Verification & Checks', description: 'Automated test execution and regression assertions.' },
            { time: '02:15', label: 'State Convergence', description: 'Synchronized visual canvas state and persistent snapshot.' }
        ]
    };
}

/**
 * Generate deeply motivated SVG Diagram section based on document topic.
 */
export function generateMotivatedSvgSection(theme: DocumentTheme, contextText?: string, title?: string): MarkdownSection {
    const id = `sec-svg-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (theme === '1776-revolution') {
        return {
            id,
            type: 'svg-diagram',
            diagramTitle: '1776 Revolutionary Ideological & Strategic Milestone Flow',
            diagramType: 'timeline',
            svgContent: generate1776SvgTimeline(),
            interactiveNodes: [
                { id: 'node-1', label: 'Common Sense (Jan)', detail: 'Thomas Paine publishes pamphlet selling 500k copies, transforming debate to total separation.' },
                { id: 'node-2', label: 'Lee Resolution (Jun)', detail: 'Richard Henry Lee formally moves that the colonies ought to be free and independent states.' },
                { id: 'node-3', label: 'Declaration Ratified (Jul 4)', detail: 'Continental Congress adopts Jeffersonian draft enshrining natural rights at Independence Hall.' },
                { id: 'node-4', label: 'Battle of Long Island (Aug)', detail: 'Strategic retreat under cover of night and fog preserving the Continental Army.' },
                { id: 'node-5', label: 'Delaware Crossing (Dec 25-26)', detail: 'Surprise counteroffensive at Trenton decisively revitalizing American revolutionary resolve.' }
            ]
        };
    }

    if (theme === 'auth-zerotrust-security') {
        return {
            id,
            type: 'svg-diagram',
            diagramTitle: 'Zero-Trust OAuth 2.1 & WebAuthn Verification Pipeline',
            diagramType: 'architecture',
            svgContent: generateAuthArchitectureSvg(),
            interactiveNodes: [
                { id: 'node-client', label: 'Client Surface', detail: 'FIDO2 Passkey / PKCE SHA-256 Code Challenge with Secure Cookies' },
                { id: 'node-edge', label: 'Envoy Edge Proxy', detail: 'TLS Termination, Rate Limiting & Anomaly Filtering (< 2ms)' },
                { id: 'node-idp', label: 'Zero-Trust IdP Core', detail: 'Ed25519 Token Mint, JWKS Auto-Rotate & Session Blacklist' },
                { id: 'node-service', label: 'Protected Microservices', detail: 'Local Signature Verification & Scoped RBAC (< 25ms)' }
            ]
        };
    }

    if (theme === 'ai-machine-learning') {
        return {
            id,
            type: 'svg-diagram',
            diagramTitle: 'AI Reasoning Pipeline & Autonomous Subagent Mesh',
            diagramType: 'pipeline',
            svgContent: generateAiArchitectureSvg(title || 'AI Architecture'),
            interactiveNodes: [
                { id: 'node-ingest', label: 'Multi-Modal Ingestion', detail: 'Prompt, audio, and visual token vectorization' },
                { id: 'node-attention', label: 'Attention Core', detail: 'Gemini 3.7 Flash thinking budget and reasoning trace' },
                { id: 'node-mcp', label: 'MCP Live Tool Mesh', detail: 'Grounded real-world execution with schema verification' },
                { id: 'node-stage', label: 'Live Visual Stage', detail: 'Real-time reactive canvas primitive synchronization' }
            ]
        };
    }

    // Default Architecture & Flow
    return {
        id,
        type: 'svg-diagram',
        diagramTitle: `${title || 'System'} — Architecture & Execution Pipeline`,
        diagramType: 'architecture',
        svgContent: generateGenericArchitectureSvg(title || 'System Architecture'),
        interactiveNodes: [
            { id: 'node-ingest', label: 'Ingestion & Triggers', detail: 'WebSocket & SSE streaming endpoints' },
            { id: 'node-engine', label: 'Execution Engine', detail: 'State machine and multi-modal synthesis compiler' },
            { id: 'node-ai', label: 'AI & MCP Mesh', detail: 'Gemini 3.7 Flash and Model Context Protocol' },
            { id: 'node-stage', label: 'Live Visual Stage', detail: 'Reactive state cache & canvas synchronization' }
        ]
    };
}

/**
 * Generate deeply motivated Citations & Primary Sources section based on document topic.
 */
export function generateMotivatedCitationSection(theme: DocumentTheme, contextText?: string): MarkdownSection {
    const id = `sec-cite-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (theme === '1776-revolution') {
        return {
            id,
            type: 'citation',
            citationItems: [
                {
                    id: 'cite-1776-1',
                    sourceTitle: 'The Declaration of Independence: Official Transcription',
                    author: 'National Archives and Records Administration',
                    year: '1776',
                    url: 'https://www.archives.gov/founding-docs/declaration-transcript',
                    quoteSnippet: 'Governments are instituted among Men, deriving their just powers from the consent of the governed.',
                    verified: true,
                    archiveName: 'National Archives',
                    badgeText: 'Primary Source'
                },
                {
                    id: 'cite-1776-2',
                    sourceTitle: 'Common Sense (Philadelphia: W. and T. Bradford, January 1776)',
                    author: 'Thomas Paine',
                    year: '1776',
                    url: 'https://www.loc.gov/item/94838421/',
                    quoteSnippet: 'A government of our own is our natural right: And when a man reflects on the precariousness of human affairs...',
                    verified: true,
                    archiveName: 'Library of Congress',
                    badgeText: 'Archival Print'
                },
                {
                    id: 'cite-1776-3',
                    sourceTitle: 'George Washington Papers: General Orders to the Continental Army',
                    author: 'Gen. George Washington',
                    year: '1776',
                    url: 'https://founders.archives.gov/documents/Washington/03-07-02-0348',
                    quoteSnippet: 'The peace and safety of our Country depends upon the success of our military endeavors...',
                    verified: true,
                    archiveName: 'Founders Online',
                    badgeText: 'Military Dispatch'
                },
                {
                    id: 'cite-1776-4',
                    sourceTitle: 'Letters of John and Abigail Adams: On Declaring Independence',
                    author: 'John Adams',
                    year: '1776',
                    url: 'https://www.masshist.org/digitaladams/',
                    quoteSnippet: 'It ought to be commemorated, as the Day of Deliverance by solemn Acts of Devotion to God Almighty.',
                    verified: true,
                    archiveName: 'Massachusetts Historical Society',
                    badgeText: 'Correspondence'
                }
            ]
        };
    }

    if (theme === 'auth-zerotrust-security') {
        return {
            id,
            type: 'citation',
            citationItems: [
                {
                    id: 'cite-rfc-1',
                    sourceTitle: 'RFC 6749: The OAuth 2.0 Authorization Framework',
                    author: 'IETF Internet Engineering Task Force',
                    year: '2012',
                    url: 'https://datatracker.ietf.org/doc/html/rfc6749',
                    quoteSnippet: 'The OAuth 2.0 authorization framework enables a third-party application to obtain limited access to an HTTP service.',
                    verified: true,
                    archiveName: 'IETF Datatracker',
                    badgeText: 'RFC Standard'
                },
                {
                    id: 'cite-rfc-2',
                    sourceTitle: 'RFC 7636: Proof Key for Code Exchange by OAuth Public Clients (PKCE)',
                    author: 'IETF OAuth Working Group',
                    year: '2015',
                    url: 'https://datatracker.ietf.org/doc/html/rfc7636',
                    quoteSnippet: 'Mitigates the authorization code interception attack for native and single-page applications.',
                    verified: true,
                    archiveName: 'IETF Datatracker',
                    badgeText: 'Security Standard'
                },
                {
                    id: 'cite-nist-1',
                    sourceTitle: 'NIST SP 800-207: Zero Trust Architecture',
                    author: 'National Institute of Standards and Technology',
                    year: '2020',
                    url: 'https://csrc.nist.gov/publications/detail/sp/800-207/final',
                    quoteSnippet: 'Zero trust assumes there is no implicit trust granted to assets or user accounts based solely on their physical or network location.',
                    verified: true,
                    archiveName: 'NIST CSRC',
                    badgeText: 'Federal Standard'
                },
                {
                    id: 'cite-w3c-1',
                    sourceTitle: 'Web Authentication: An API for accessing Public Key Credentials (Level 3)',
                    author: 'W3C WebAuthn Working Group',
                    year: '2024',
                    url: 'https://www.w3.org/TR/webauthn-3/',
                    quoteSnippet: 'Defines an API enabling the creation and use of strong, attested, scoped, public key-based credentials by web applications.',
                    verified: true,
                    archiveName: 'W3C Technical Reports',
                    badgeText: 'W3C Recommendation'
                }
            ]
        };
    }

    if (theme === 'ai-machine-learning') {
        return {
            id,
            type: 'citation',
            citationItems: [
                {
                    id: 'cite-ai-1',
                    sourceTitle: 'Attention Is All You Need',
                    author: 'Vaswani, A., Shazeer, N., Parmar, N., et al.',
                    year: '2017',
                    url: 'https://arxiv.org/abs/1706.03762',
                    quoteSnippet: 'We propose the Transformer, a model architecture eschewing recurrence and relying entirely on an attention mechanism to draw global dependencies.',
                    verified: true,
                    archiveName: 'arXiv.org',
                    badgeText: 'Foundation Paper'
                },
                {
                    id: 'cite-ai-2',
                    sourceTitle: 'Model Context Protocol (MCP) Specification',
                    author: 'Anthropic & Open Source Community',
                    year: '2024',
                    url: 'https://modelcontextprotocol.io/',
                    quoteSnippet: 'Standardized open protocol connecting AI assistants to external tools, databases, and dynamic developer environments.',
                    verified: true,
                    archiveName: 'MCP Spec Docs',
                    badgeText: 'Protocol Standard'
                }
            ]
        };
    }

    // Default Academic & Systems Citations
    return {
        id,
        type: 'citation',
        citationItems: [
            {
                id: 'cite-gen-1',
                sourceTitle: 'Distributed Systems: Principles and Paradigms (3rd Edition)',
                author: 'Andrew S. Tanenbaum, Maarten van Steen',
                year: '2017',
                url: 'https://www.distributed-systems.net/',
                quoteSnippet: 'A distributed system is a collection of autonomous computing elements that appears to its users as a single coherent system.',
                verified: true,
                archiveName: 'Academic Reference',
                badgeText: 'Core Literature'
            },
            {
                id: 'cite-gen-2',
                sourceTitle: 'Designing Data-Intensive Applications',
                author: 'Martin Kleppmann',
                year: '2017',
                url: 'https://dataintensive.net/',
                quoteSnippet: 'Reliability, scalability, and maintainability are the three core concerns that must guide architecture decisions.',
                verified: true,
                archiveName: "O'Reilly Media",
                badgeText: 'System Design'
            }
        ]
    };
}

/**
 * Guarantee that every heading in the document is followed by rich, substantive content
 * (paragraphs, comparative tables, checklists, or quotes) and no heading is left orphaned or empty.
 */
export function ensureCompleteSections(sections: MarkdownSection[], docTitle: string = 'Document'): MarkdownSection[] {
    if (!Array.isArray(sections) || sections.length === 0) return sections;

    const result: MarkdownSection[] = [];
    for (let i = 0; i < sections.length; i++) {
        const current = sections[i];
        result.push(current);

        if (current.type === 'heading') {
            const next = sections[i + 1];
            const isOrphaned = !next || next.type === 'heading';

            if (isOrphaned) {
                const headingText = (current.content || '').toLowerCase();
                const now = Date.now();
                const rand = () => Math.random().toString(36).slice(2, 6);

                if (/comparative|comparison|matrix|ideals vs|versus/i.test(headingText)) {
                    if (/1776/i.test(docTitle) || /1776/i.test(headingText)) {
                        result.push({
                            id: `sec-p-comp-${now}-${rand()}`,
                            type: 'paragraph',
                            content: 'A critical historical assessment of 1776 requires juxtaposing the transcendent philosophical ideals proclaimed in Philadelphia with the harsh sociopolitical and military realities on the ground.'
                        });
                        result.push({
                            id: `sec-tbl-comp-${now}-${rand()}`,
                            type: 'table',
                            tableHeaders: ['Dimension / Domain', 'Enlightenment Ideal Proclaimed', 'Wartime & Historical Reality', 'Enduring Evolution'],
                            tableRows: [
                                ['Universal Human Equality', '“All men are created equal” with unalienable natural rights', 'Institution of chattel slavery persisted; legal rights restricted to property-owning males', 'Catalyzed abolitionist and civil rights constitutional amendments (13th, 14th, 19th)'],
                                ['Governance by Consent', 'Government derives legitimate authority solely from the governed', 'Colonies fractured between Patriots (40-45%), Loyalists (15-20%), and neutral populations', 'Established foundation for modern global constitutional democracy and self-determination'],
                                ['Military Sovereignty', 'Unified civilian militia rising spontaneously to defend liberty', 'Severe supply shortages, discipline issues, and mutinies; victory required professionalization and French alliance', 'Forged tradition of civilian control over professional military apparatus'],
                                ['Economic Self-Sufficiency', 'Freedom from mercantilist taxation and imperial trade constraints', 'Rampant currency depreciation (“Not worth a Continental”), blockade, and fiscal crisis', 'Pioneered national debt consolidation and modern commercial banking system']
                            ]
                        });
                    } else if (/auth|security|identity/i.test(docTitle) || /auth|security|identity/i.test(headingText)) {
                        result.push({
                            id: `sec-p-comp-${now}-${rand()}`,
                            type: 'paragraph',
                            content: 'Evaluating modern identity frameworks reveals key trade-offs between cryptographic security, implementation complexity, and user friction across distributed environments.'
                        });
                        result.push({
                            id: `sec-tbl-comp-${now}-${rand()}`,
                            type: 'table',
                            tableHeaders: ['Identity Architecture', 'Security Strength', 'User Experience (Friction)', 'Implementation Complexity', 'Production Readiness'],
                            tableRows: [
                                ['FIDO2 / WebAuthn Passkeys', 'Cryptographically Immune to Phishing', 'Zero Friction (Biometric 1-touch)', 'Medium (Hardware API Handshake)', 'Production Ready (Enforced)'],
                                ['OAuth 2.1 + PKCE', 'High (Protected against Interception)', 'Seamless OAuth Redirect', 'Standardized (OIDC Discovery)', 'Production Ready (100%)'],
                                ['Symmetric JWT Tokens', 'Vulnerable to Key Leakage', 'Low Latency Verification', 'Low (Single Secret Key)', 'Deprecated for Edge'],
                                ['Legacy Password + SMS 2FA', 'Vulnerable to SIM Swapping', 'High Friction & SMS Latency', 'Low (Legacy Standard)', 'Decommissioned']
                            ]
                        });
                    } else {
                        result.push({
                            id: `sec-p-comp-${now}-${rand()}`,
                            type: 'paragraph',
                            content: `Comparative analysis of operational dimensions and strategic trade-offs for ${docTitle}:`
                        });
                        result.push({
                            id: `sec-tbl-comp-${now}-${rand()}`,
                            type: 'table',
                            tableHeaders: ['Component / Strategy', 'Primary Benefit', 'Operational Overhead', 'Target SLA / Status'],
                            tableRows: [
                                ['High-Throughput Architecture', 'Sub-millisecond latency & linear scaling', 'Requires distributed caching & sharding', '99.99% Availability'],
                                ['Automated Verification Loops', 'Zero manual regression defects', 'Continuous CI test execution cycles', 'Enforced Pre-Merge'],
                                ['Modular Domain Boundaries', 'Independent service iteration', 'Boundary serialization & schema contracts', 'Active Standard']
                            ]
                        });
                    }
                } else if (/takeaway|milestone|legacy|action|checklist|next step|conclusion|recommendation/i.test(headingText)) {
                    if (/1776/i.test(docTitle) || /1776/i.test(headingText)) {
                        result.push({
                            id: `sec-p-take-${now}-${rand()}`,
                            type: 'paragraph',
                            content: 'The legacy of 1776 endures not as a completed revolution, but as a living philosophical mandate that continuously challenges societies to expand the boundaries of freedom, civic responsibility, and democratic governance.'
                        });
                        result.push({
                            id: `sec-chk-take-${now}-${rand()}`,
                            type: 'checklist',
                            checklistItems: [
                                { id: `c-1-${now}-${rand()}`, text: 'Sovereignty established through formal diplomatic recognition and international treaties', done: true },
                                { id: `c-2-${now}-${rand()}`, text: 'Constitutional codification of checks and balances and separated legislative powers', done: true },
                                { id: `c-3-${now}-${rand()}`, text: 'Institutionalization of regular democratic elections and peaceful transfer of authority', done: true },
                                { id: `c-4-${now}-${rand()}`, text: 'Continuous expansion of constitutional guarantees to fulfill the universal promise of equal liberty', done: true }
                            ]
                        });
                    } else if (/auth|security|identity/i.test(docTitle) || /auth|security|identity/i.test(headingText)) {
                        result.push({
                            id: `sec-p-take-${now}-${rand()}`,
                            type: 'paragraph',
                            content: 'Execution roadmap for rolling out Zero-Trust identity infrastructure and automated compliance guardrails:'
                        });
                        result.push({
                            id: `sec-chk-take-${now}-${rand()}`,
                            type: 'checklist',
                            checklistItems: [
                                { id: `c-auth-1-${now}-${rand()}`, text: 'Deploy OAuth 2.1 authorization server with PKCE verification and JWKS rotation', done: true },
                                { id: `c-auth-2-${now}-${rand()}`, text: 'Enforce FIDO2/WebAuthn passkey registration across administrative access tiers', done: true },
                                { id: `c-auth-3-${now}-${rand()}`, text: 'Establish distributed Redis session revocation with sub-10ms global invalidation', done: true },
                                { id: `c-auth-4-${now}-${rand()}`, text: 'Execute automated SOC2 Type II compliance audit and penetration verification', done: false }
                            ]
                        });
                    } else {
                        result.push({
                            id: `sec-p-take-${now}-${rand()}`,
                            type: 'paragraph',
                            content: `Strategic milestones and implementation deliverables for ${docTitle}:`
                        });
                        result.push({
                            id: `sec-chk-take-${now}-${rand()}`,
                            type: 'checklist',
                            checklistItems: [
                                { id: `c-gen-1-${now}-${rand()}`, text: `Core architectural components initialized and verified for ${docTitle}`, done: true },
                                { id: `c-gen-2-${now}-${rand()}`, text: 'Automated test suite and regression guardrails deployed to CI pipeline', done: true },
                                { id: `c-gen-3-${now}-${rand()}`, text: 'Performance telemetry, latency profiling, and error budget alerting configured', done: true },
                                { id: `c-gen-4-${now}-${rand()}`, text: 'Production deployment and operational validation across all target surfaces', done: false }
                            ]
                        });
                    }
                } else if (/quote|insight|primary source/i.test(headingText)) {
                    result.push({
                        id: `sec-quote-${now}-${rand()}`,
                        type: 'quote',
                        content: /1776/i.test(docTitle)
                            ? '“These are the times that try men\'s souls. The summer soldier and the sunshine patriot will, in this crisis, shrink from the service of their country; but he that stands by it now, deserves the love and thanks of man and woman.” — Thomas Paine, The American Crisis (December 23, 1776)'
                            : `“Simplicity is prerequisite for reliability. High-leverage architecture emerges from clear boundaries and continuous verification.” — Core Engineering Principle`
                    });
                } else {
                    result.push({
                        id: `sec-p-auto-${now}-${rand()}`,
                        type: 'paragraph',
                        content: `Detailed structural analysis and domain foundations supporting ${current.content || 'this section'}. This comprehensive review outlines the architectural invariants, operational considerations, and long-term implications for the broader framework.`
                    });
                }
            }
        }
    }
    return result;
}

/**
 * Synthesize a comprehensive, executive document hierarchy with rich 4D Thinking Multi-Modal capabilities,
 * gracefully adapting and pulling back to clean text if the user requests concise/text-only formats.
 */
export function synthesizeComprehensiveDocument(prompt: string, customTitle?: string, author?: string): MarkdownDocumentData {
    const theme = detectDocumentTheme(prompt, customTitle);
    const docTitle = customTitle && customTitle !== 'Markdown Document' ? customTitle : extractDocumentTitleFromPrompt(prompt);
    const docAuthor = getActiveUserName(author);

    // Check if user requested pulling back or asked for minimal / text-only / concise output
    const isMinimal = /concise|minimal|text[- ]only|no[- ]media|no[- ]images?|no[- ]video|no[- ]diagrams?|without[- ](media|images|diagrams|video)|simple[- ]notes|clean[- ]text/i.test(prompt);

    if (theme === '1776-revolution') {
        const sections: MarkdownSection[] = [
            {
                id: `sec-h1-${Date.now()}-1`,
                type: 'heading',
                level: 1,
                content: '1. Executive Summary: The Genesis of Modern Republicanism'
            },
            {
                id: `sec-p-${Date.now()}-1`,
                type: 'paragraph',
                content: 'The year 1776 stands as an unparalleled watershed moment in human history, marking not merely the birth of a new nation but the articulation of revolutionary political philosophy that would reverberate across continents and centuries. It was the year the American colonies formally declared their independence from Great Britain, a bold and audacious act predicated on Enlightenment ideals of natural rights, popular sovereignty, and the right of a people to alter or abolish a destructive government.'
            },
            {
                id: `sec-p-${Date.now()}-2`,
                type: 'paragraph',
                content: 'The principles enshrined in the Declaration of Independence—that all men are created equal, endowed with unalienable rights to life, liberty, and the pursuit of happiness—established a new paradigm for legitimate governance: government by consent of the governed. Understanding 1776 is crucial for grasping the origins of modern political thought, the trajectory of democratic development, and the ongoing struggle to realize universal human rights.'
            }
        ];

        // 4D Multi-Modal Block 1: Location Imagery / Spatial Anchor
        if (!isMinimal) {
            sections.push(generateMotivatedLocationSection('1776-revolution', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-2`,
                type: 'heading',
                level: 1,
                content: '2. Key Pillars & Chronology: From Grievances to Universal Truths'
            },
            {
                id: `sec-h2-${Date.now()}-1`,
                type: 'heading',
                level: 2,
                content: '2.1 The Enlightenment’s Crucible & Thomas Paine’s Catalyst'
            },
            {
                id: `sec-p-${Date.now()}-3`,
                type: 'paragraph',
                content: 'The intellectual currents of the European Enlightenment profoundly shaped the American revolutionary mindset. Thinkers like John Locke, with his theories of natural rights and the social contract, and Montesquieu, with his emphasis on the separation of powers, provided the philosophical scaffolding. In January 1776, Thomas Paine published Common Sense, transforming philosophical abstraction into urgent political action for millions of colonists.'
            },
            {
                id: `sec-callout-${Date.now()}-1`,
                type: 'callout',
                calloutType: 'info',
                calloutTitle: 'Lockean Influence & Natural Rights',
                content: 'John Locke’s \'Two Treatises of Government\' (1689) directly influenced Jefferson’s articulation of \'life, liberty, and the pursuit of happiness,\' evolving Locke’s \'life, liberty, and property\' to emphasize a broader human aspiration.'
            }
        );

        // 4D Multi-Modal Block 2: Interactive SVG Timeline & Ideological Graph
        if (!isMinimal) {
            sections.push(generateMotivatedSvgSection('1776-revolution', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h2-${Date.now()}-2`,
                type: 'heading',
                level: 2,
                content: '2.2 The Declaration of Independence: Anatomy of a Revolution'
            },
            {
                id: `sec-p-${Date.now()}-4`,
                type: 'paragraph',
                content: 'Drafted by Thomas Jefferson and refined by the Committee of Five (John Adams, Benjamin Franklin, Roger Sherman, Robert Livingston), the Declaration was structured into five distinct sections: the Preamble, the Statement of Human Rights, the Charges Against Human Rights, the Statement of Separation, and the Signatures.'
            },
            {
                id: `sec-tbl-${Date.now()}-1`,
                type: 'table',
                tableHeaders: ['Date & Milestone', 'Key Figures', 'Core Philosophy / Action', 'Global Ramifications'],
                tableRows: [
                    ['Common Sense (Jan 1776)', 'Thomas Paine', 'Rejection of hereditary monarchy & divine right', 'Catalyzed mass popular mandate for complete separation'],
                    ['Evacuation of Boston (Mar 1776)', 'Gen. Washington, Henry Knox', 'Artillery from Ticonderoga fortifies Dorchester Heights', 'First major military strategic triumph for Continental Army'],
                    ['Declaration Ratified (July 4, 1776)', 'Jefferson, Franklin, Adams', 'Universal natural rights & governance by consent', 'Inaugurated modern constitutional democracy worldwide'],
                    ['Battle of Long Island (Aug 1776)', 'Gen. Howe, Gen. Washington', 'Tactical retreat under night fog preserving army', 'Prevented encirclement and annihilation of American forces'],
                    ['Crossing of the Delaware (Dec 25–26)', 'George Washington, Col. John Glover', 'Surprise counterattack on Hessian garrison at Trenton', 'Reignited revolutionary morale and saved the colonial cause']
                ]
            },
            {
                id: `sec-quote-${Date.now()}-1`,
                type: 'quote',
                content: '“We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness.” — The Declaration of Independence (July 4, 1776)'
            }
        );

        // 4D Multi-Modal Block 3: Video / Temporal Moment Simulation
        if (!isMinimal) {
            sections.push(generateMotivatedVideoSection('1776-revolution', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-3`,
                type: 'heading',
                level: 1,
                content: '3. Comparative Analysis: Ideals vs. Realities of 1776'
            },
            {
                id: `sec-p-${Date.now()}-5`,
                type: 'paragraph',
                content: 'A rigorous historical analysis of 1776 requires evaluating the revolutionary ideals articulated in the Declaration of Independence against the complex socioeconomic, racial, and military realities of the era. While the philosophical proclamation of universal equality set an enduring standard for human rights, the immediate reality was characterized by profound contradictions, bitter domestic divisions between Patriots and Loyalists, and grueling military struggles.'
            },
            {
                id: `sec-tbl-${Date.now()}-2`,
                type: 'table',
                tableHeaders: ['Dimension / Domain', 'Enlightenment Ideal Proclaimed', 'Historical & Wartime Reality', 'Enduring Legacy & Evolution'],
                tableRows: [
                    ['Universal Equality', '“All men are created equal” endowed with natural rights', 'Institution of chattel slavery persisted; legal franchise limited to property-owning males', 'Established the foundational moral benchmark that powered the 19th-century abolitionist and 20th-century civil rights movements'],
                    ['Governance by Consent', 'Government derives legitimate authority solely from the consent of the governed', 'Deep colonial divisions: ~40-45% Patriots, ~15-20% Loyalists, and large neutral populations', 'Inaugurated modern constitutional republicanism and the right of self-determination worldwide'],
                    ['Military Sovereignty', 'Citizen-soldier militia spontaneously defending home and liberty', 'Severe winter supply crises, currency collapse, and near-annihilation until professionalized under Washington and reinforced by French allies', 'Forged the bedrock constitutional principle of civilian democratic command over military forces'],
                    ['Economic Freedom', 'Liberation from mercantilist imperial taxes and trade restrictions', 'Crippling inflation (“Not worth a Continental”), British naval blockades, and fiscal turmoil', 'Pioneered American public debt management, sovereign credit, and diversified transatlantic commerce']
                ]
            },
            {
                id: `sec-h1-${Date.now()}-4`,
                type: 'heading',
                level: 1,
                content: '4. Strategic Takeaways: The Enduring Legacy of 1776'
            },
            {
                id: `sec-p-${Date.now()}-6`,
                type: 'paragraph',
                content: 'The events of 1776 fundamentally transformed political philosophy from theoretical discourse into lived institutional governance. The enduring power of the American Revolution lies in its dynamic, self-correcting constitutional framework that continues to challenge successive generations to fulfill its founding promises.'
            },
            {
                id: `sec-chk-${Date.now()}-1`,
                type: 'checklist',
                checklistItems: [
                    { id: `c-1-${Date.now()}`, text: 'Sovereign nationhood established through diplomatic alliances and formal recognition (1778 Treaty of Alliance with France)', done: true },
                    { id: `c-2-${Date.now()}`, text: 'Drafting of foundational state declarations of rights (e.g. Virginia Declaration of Rights, Pennsylvania Constitution)', done: true },
                    { id: `c-3-${Date.now()}`, text: 'Continental Army established as unified defense under strict civilian congressional oversight', done: true },
                    { id: `c-4-${Date.now()}`, text: 'Institutionalization of regular democratic elections and the rule of law over hereditary monarchy', done: true },
                    { id: `c-5-${Date.now()}`, text: 'Universal expansion of constitutional rights and civic liberties across succeeding centuries', done: false }
                ]
            },
            {
                id: `sec-quote-${Date.now()}-2`,
                type: 'quote',
                content: '“These are the times that try men\'s souls. The summer soldier and the sunshine patriot will, in this crisis, shrink from the service of their country; but he that stands by it now, deserves the love and thanks of man and woman.” — Thomas Paine, The American Crisis (December 23, 1776)'
            }
        );

        // 4D Multi-Modal Block 4: Grounded Citations & Primary Sources
        if (!isMinimal) {
            sections.push(generateMotivatedCitationSection('1776-revolution', prompt));
        }

        return {
            title: 'The Pivotal Year: 1776 and the Birth of a Nation',
            subtitle: 'Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty',
            author: docAuthor,
            lastUpdated: 'Just now',
            tags: ['history', 'american revolution', 'declaration of independence', 'political philosophy', 'founding principles'],
            sections: ensureCompleteSections(sections, docTitle)
        };
    }

    if (theme === 'auth-zerotrust-security') {
        const sections: MarkdownSection[] = [
            {
                id: `sec-h1-${Date.now()}-1`,
                type: 'heading',
                level: 1,
                content: '1. Executive Summary: Identity & Access Architecture'
            },
            {
                id: `sec-p-${Date.now()}-1`,
                type: 'paragraph',
                content: 'This technical specification defines the enterprise identity and access management (IAM) architecture for high-throughput distributed systems. Engineered around Zero-Trust principles, the system enforces continuous verification, least-privilege RBAC/ABAC access control, and hardware-backed cryptographic credentials across web, mobile, and subagent API endpoints.'
            },
            {
                id: `sec-p-${Date.now()}-2`,
                type: 'paragraph',
                content: 'The core authentication fabric implements OAuth 2.1 with PKCE (Proof Key for Code Exchange), OIDC discovery, Passkey/WebAuthn biometric authentication, and dual-token asymmetric JWT rotation with Redis-backed revocation. All authentication exchanges guarantee sub-25ms verification latency while maintaining cryptographic resistance to replay, CSRF, token theft, and credential stuffing attacks.'
            }
        ];

        // 4D Location Imagery / Network Topology Block
        if (!isMinimal) {
            sections.push(generateMotivatedLocationSection('auth-zerotrust-security', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-2`,
                type: 'heading',
                level: 1,
                content: '2. Architectural Pillars & Protocol Chronology'
            },
            {
                id: `sec-h2-${Date.now()}-1`,
                type: 'heading',
                level: 2,
                content: '2.1 Protocol Specification: OAuth 2.1 & PKCE Handshake'
            },
            {
                id: `sec-p-${Date.now()}-3`,
                type: 'paragraph',
                content: 'Client applications authenticate through an authorization code grant enhanced with cryptographically random SHA-256 code verifiers and challenges. Short-lived access tokens (5 minutes) are issued alongside high-entropy refresh tokens stored inside Secure HttpOnly SameSite=Strict cookies.'
            },
            {
                id: `sec-callout-${Date.now()}-1`,
                type: 'callout',
                calloutType: 'info',
                calloutTitle: 'Security Guardrail: Dual-Token Asymmetric Cryptography',
                content: 'Access tokens are signed using asymmetric EdDSA (Ed25519) keys with automated 30-day key rotation via JWKS endpoints. Public keys are cached locally in memory with TTL to eliminate inter-service database bottlenecks.'
            }
        );

        // 4D Multi-Modal Block: SVG Architecture Diagram
        if (!isMinimal) {
            sections.push(generateMotivatedSvgSection('auth-zerotrust-security', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h2-${Date.now()}-2`,
                type: 'heading',
                level: 2,
                content: '2.2 Multi-Factor & Biometric WebAuthn Pipeline'
            },
            {
                id: `sec-p-${Date.now()}-4`,
                type: 'paragraph',
                content: 'To eliminate credential replay and phishing vulnerabilities, primary authentication supports FIDO2/WebAuthn passkeys utilizing platform authenticators (Touch ID, Face ID, Windows Hello, YubiKey). Fallback authentication incorporates TOTP (RFC 6238) and encrypted one-time backup codes.'
            },
            {
                id: `sec-tbl-${Date.now()}-1`,
                type: 'table',
                tableHeaders: ['Authentication Component', 'Protocol / Standard', 'Core Architecture / Impact', 'Validation & Status'],
                tableRows: [
                    ['Identity Provider (IdP)', 'OIDC / OAuth 2.1 + PKCE', 'Centralized token issuance and user directory federation', 'Production Ready (100%)'],
                    ['Passkey / WebAuthn', 'FIDO2 / W3C WebAuthn Level 3', 'Phishing-resistant public-key cryptography on device', 'Enforced for Admin'],
                    ['Token Storage & Transport', 'HttpOnly SameSite=Strict Cookies', 'Immunity against client-side XSS token exfiltration', 'Verified Active'],
                    ['Session Revocation', 'Redis Cluster + Bloom Filter', 'Global near-instant session invalidation (< 10ms propagation)', 'Active Cluster'],
                    ['Rate Limiting & Abuse Defense', 'Token Bucket / Sliding Window', 'IP and Account-based throttling against brute force attacks', 'Enforced (Edge)']
                ]
            },
            {
                id: `sec-quote-${Date.now()}-1`,
                type: 'quote',
                content: '“Never trust, always verify. Security is not a barrier to delivery, but the foundational architecture that makes high-velocity innovation resilient and durable.” — Zero Trust Architecture Principle'
            }
        );

        // 4D Video / Protocol Simulation
        if (!isMinimal) {
            sections.push(generateMotivatedVideoSection('auth-zerotrust-security', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-3`,
                type: 'heading',
                level: 1,
                content: '3. Strategic Takeaways & Delivery Checklist'
            },
            {
                id: `sec-chk-${Date.now()}-1`,
                type: 'checklist',
                checklistItems: [
                    { id: `c-auth-1-${Date.now()}`, text: 'Implement OAuth 2.1 authorization server with PKCE challenge verification', done: true },
                    { id: `c-auth-2-${Date.now()}`, text: 'Configure Ed25519 asymmetric key pair generation and JWKS distribution endpoint', done: true },
                    { id: `c-auth-3-${Date.now()}`, text: 'Deploy WebAuthn/Passkey registration and authentication ceremony handlers', done: true },
                    { id: `c-auth-4-${Date.now()}`, text: 'Integrate Redis session blacklist and distributed sliding-window rate limiters', done: false },
                    { id: `c-auth-5-${Date.now()}`, text: 'Conduct comprehensive penetration testing and SOC2 Type II audit validation', done: false }
                ]
            }
        );

        // 4D Grounded Citations (RFC & Standards)
        if (!isMinimal) {
            sections.push(generateMotivatedCitationSection('auth-zerotrust-security', prompt));
        }

        return {
            title: 'Technical Specification: Scalable Authentication & Zero-Trust Identity Infrastructure',
            subtitle: 'Comprehensive Architecture, Protocol Specifications, Token Lifecycle, and Security Guardrails',
            author: docAuthor,
            lastUpdated: 'Just now',
            tags: ['Authentication', 'Security', 'OAuth2', 'ZeroTrust', 'Identity', 'WebAuthn'],
            sections: ensureCompleteSections(sections, docTitle)
        };
    }

    if (theme === 'ai-machine-learning') {
        const sections: MarkdownSection[] = [
            {
                id: `sec-h1-${Date.now()}-1`,
                type: 'heading',
                level: 1,
                content: '1. Executive Summary: AI Reasoning Engine Architecture'
            },
            {
                id: `sec-p-${Date.now()}-1`,
                type: 'paragraph',
                content: `This technical architecture defines the AI reasoning, multi-modal ingestion, and autonomous subagent execution mesh for ${docTitle}. Engineered around Gemini 3.7 Flash and lightweight subagent worker pools, the system enables real-time 60fps streaming, live canvas primitive synthesis, and tool grounding.`
            },
            {
                id: `sec-p-${Date.now()}-2`,
                type: 'paragraph',
                content: 'By integrating Model Context Protocol (MCP) live servers with asynchronous thinking loops and MLA project context graphs, the architecture provides deterministic tool execution with autonomous error recovery.'
            }
        ];

        if (!isMinimal) {
            sections.push(generateMotivatedLocationSection('ai-machine-learning', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-2`,
                type: 'heading',
                level: 1,
                content: '2. Multi-Modal Pipeline & Subagent Orchestration'
            },
            {
                id: `sec-h2-${Date.now()}-1`,
                type: 'heading',
                level: 2,
                content: '2.1 Attention Mesh & Subagent Worker Pool'
            },
            {
                id: `sec-p-${Date.now()}-3`,
                type: 'paragraph',
                content: 'Incoming requests are decomposed by an orchestrator into directed acyclic graphs (DAGs). Up to 64 parallel subagents running on low-latency Gemini Flash Lite execute file searches, static analysis, and tool calls before feeding unified context into the primary reasoning model.'
            },
            {
                id: `sec-callout-${Date.now()}-1`,
                type: 'callout',
                calloutType: 'info',
                calloutTitle: 'Adaptive Thinking Budget & Latency Optimization',
                content: 'The model dynamically scales its thinking budget between 1,024 and 16,384 tokens based on task complexity, ensuring fast responses for simple queries and deep proofs for complex engineering tasks.'
            }
        );

        if (!isMinimal) {
            sections.push(generateMotivatedSvgSection('ai-machine-learning', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h2-${Date.now()}-2`,
                type: 'heading',
                level: 2,
                content: '2.2 Real-time Canvas Stage Synchronization'
            },
            {
                id: `sec-p-${Date.now()}-4`,
                type: 'paragraph',
                content: 'Outputs from the reasoning core are compiled directly into reactive canvas primitives—including interactive node graphs, metric dashboards, and rich multi-modal documents with verified citations and video walkthroughs.'
            },
            {
                id: `sec-tbl-${Date.now()}-1`,
                type: 'table',
                tableHeaders: ['Layer / Component', 'Model / Engine', 'Execution Budget', 'Target Latency'],
                tableRows: [
                    ['Subagent Preprocessing', 'Gemini 3.5 Flash Lite', 'Parallel 64-worker pool', '< 120ms'],
                    ['Thinking Core Synthesis', 'Gemini 3.7 Flash', '1024-8192 thinking tokens', '< 450ms TTFT'],
                    ['MCP Tool Execution', 'Model Context Protocol', 'Deterministic RPC schema', '< 80ms'],
                    ['Canvas State Convergence', 'Liquid Glass Reactive Cache', 'Immediate local persistence', '< 16ms (60fps)']
                ]
            },
            {
                id: `sec-quote-${Date.now()}-1`,
                type: 'quote',
                content: '“Intelligence is not merely token generation, but structured reasoning grounded in verified tools, real-world context, and interactive visual feedback.”'
            }
        );

        if (!isMinimal) {
            sections.push(generateMotivatedVideoSection('ai-machine-learning', prompt, docTitle));
        }

        sections.push(
            {
                id: `sec-h1-${Date.now()}-3`,
                type: 'heading',
                level: 1,
                content: '3. Strategic Milestones & Validation Criteria'
            },
            {
                id: `sec-chk-${Date.now()}-1`,
                type: 'checklist',
                checklistItems: [
                    { id: `c-ai-1-${Date.now()}`, text: 'Configure subagent pool concurrency limits and token backpressure limits', done: true },
                    { id: `c-ai-2-${Date.now()}`, text: 'Integrate MCP tool schema validator and automatic retry wrappers', done: true },
                    { id: `c-ai-3-${Date.now()}`, text: 'Conduct comprehensive evaluation on multimodal reasoning benchmarks', done: false }
                ]
            }
        );

        if (!isMinimal) {
            sections.push(generateMotivatedCitationSection('ai-machine-learning', prompt));
        }

        return {
            title: docTitle,
            subtitle: `Architectural specification, reasoning topology, and subagent orchestration for ${docTitle}`,
            author: docAuthor,
            lastUpdated: 'Just now',
            tags: ['AI', 'MachineLearning', 'Gemini', 'Subagents', 'Architecture'],
            sections: ensureCompleteSections(sections, docTitle)
        };
    }

    // Generic / Cloud / Product Document Synthesis with 4D Capabilities
    const sections: MarkdownSection[] = [
        {
            id: `sec-h1-${Date.now()}-1`,
            type: 'heading',
            level: 1,
            content: `1. Executive Summary: Strategic Blueprint for ${docTitle}`
        },
        {
            id: `sec-p-${Date.now()}-1`,
            type: 'paragraph',
            content: `This document outlines the core architecture, functional requirements, and execution roadmap for ${docTitle}. It establishes design principles, interface contracts, and automated verification criteria to ensure high system reliability and seamless user experiences.`
        },
        {
            id: `sec-p-${Date.now()}-2`,
            type: 'paragraph',
            content: `By leveraging modern distributed systems, event-driven microservices, and AI-native automation, the initiative addresses critical operational challenges while establishing a scalable foundation for rapid feature iteration and long-term durability.`
        }
    ];

    if (!isMinimal) {
        sections.push(generateMotivatedLocationSection(theme, prompt, docTitle));
    }

    sections.push(
        {
            id: `sec-h1-${Date.now()}-2`,
            type: 'heading',
            level: 1,
            content: '2. Key Architectural Pillars & System Design'
        },
        {
            id: `sec-h2-${Date.now()}-1`,
            type: 'heading',
            level: 2,
            content: '2.1 Modular System Architecture & Data Flow'
        },
        {
            id: `sec-p-${Date.now()}-3`,
            type: 'paragraph',
            content: 'The proposed system is partitioned into decoupled, independently deployable domains communicating over bidirectional streaming protocols and strongly typed RPC schemas. State management combines transactional ACID persistence with low-latency caching layers.'
        },
        {
            id: `sec-callout-${Date.now()}-1`,
            type: 'callout',
            calloutType: 'info',
            calloutTitle: 'Core Architecture Insight',
            content: 'All components adhere to decoupled event-driven contracts with real-time bidirectional synchronization across surfaces, preventing single points of failure.'
        }
    );

    if (!isMinimal) {
        sections.push(generateMotivatedSvgSection(theme, prompt, docTitle));
    }

    sections.push(
        {
            id: `sec-h2-${Date.now()}-2`,
            type: 'heading',
            level: 2,
            content: '2.2 Operational Reliability & Automated Guardrails'
        },
        {
            id: `sec-p-${Date.now()}-4`,
            type: 'paragraph',
            content: 'Comprehensive telemetry, distributed tracing, and automated regression testing are integrated directly into the pipeline, ensuring that every deployment adheres strictly to performance budgets and architectural constraints.'
        },
        {
            id: `sec-tbl-${Date.now()}-1`,
            type: 'table',
            tableHeaders: ['Capability / Component', 'Specification', 'Performance Target', 'Validation Status'],
            tableRows: [
                ['Core Runtime Protocol', 'SSE bidirectional stream with JSON-RPC schemas', '< 30ms time-to-first-token', 'Verified (100%)'],
                ['Data Persistence', 'Synchronized reactive session state & localStorage', 'Zero data loss on reload', 'Active'],
                ['Security Boundaries', 'Sandboxed execution with capability-based permissions', 'Strict prompt confirmation for mutations', 'Enforced'],
                ['Observability & Metrics', 'Real-time distributed tracing & sparkline metrics', 'Sub-minute alert MTTR', 'Active']
            ]
        },
        {
            id: `sec-quote-${Date.now()}-1`,
            type: 'quote',
            content: '“Simplicity is prerequisite for reliability. Great architecture is achieved not when there is nothing more to add, but when there is nothing left to take away.”'
        }
    );

    if (!isMinimal) {
        sections.push(generateMotivatedVideoSection(theme, prompt, docTitle));
    }

    sections.push(
        {
            id: `sec-h1-${Date.now()}-3`,
            type: 'heading',
            level: 1,
            content: '3. Actionable Milestones & Convergence Checklist'
        },
        {
            id: `sec-chk-${Date.now()}-1`,
            type: 'checklist',
            checklistItems: [
                { id: `c-1-${Date.now()}`, text: `Define type-safe interfaces and event emitters for ${docTitle}`, done: true },
                { id: `c-2-${Date.now()}`, text: 'Implement visual unit and integration test assertions with 100% pass rate', done: true },
                { id: `c-3-${Date.now()}`, text: 'Execute end-to-end regression audit across desktop and mobile surfaces', done: false }
            ]
        }
    );

    if (!isMinimal) {
        sections.push(generateMotivatedCitationSection(theme, prompt));
    }

    return {
        title: docTitle,
        subtitle: `Comprehensive specification, architectural blueprint, and strategic roadmap for ${docTitle}`,
        author: docAuthor,
        lastUpdated: 'Just now',
        tags: ['Architecture', 'Specification', 'Engineering', 'StrategicRoadmap', 'Milestones'],
        sections: ensureCompleteSections(sections, docTitle)
    };
}

/**
 * Synthesizes a dedicated media-centric presentation document for explicit picture/image or video generation requests.
 * Places the prominent media section (editorial-image or video) at the very top of the narrative canvas,
 * paired with inline markdown media syntax, historical / technical analysis, quote callouts, and data breakdowns.
 */
export function synthesizeMediaDocument(prompt: string, kind: 'image' | 'video', customTitle?: string, author?: string): MarkdownDocumentData {
    const theme = detectDocumentTheme(prompt, customTitle);
    const docTitle = customTitle && customTitle !== 'Markdown Document' ? customTitle : extractDocumentTitleFromPrompt(prompt);
    const docAuthor = getActiveUserName(author);
    const isLexington = /lexington|concord|minutemen|first shot|buckman|pitcairn|parker/i.test(`${prompt} ${docTitle}`);

    const sections: MarkdownSection[] = [];

    // 1. Heading 1: Main Title
    sections.push({
        id: `sec-h1-${Date.now()}-1`,
        type: 'heading',
        level: 1,
        content: `1. Visual Archive & Narrative: ${docTitle}`
    });

    // 2. Executive Overview Paragraph
    let overviewText = '';
    if (isLexington) {
        overviewText = 'At sunrise on April 19, 1775, approximately 77 colonial minutemen commanded by Captain John Parker assembled on Lexington Green in Massachusetts, standing in quiet defiance against more than 200 British Regulars under Major John Pitcairn. When an unconfirmed first shot rang out, a volley of musket fire followed, marking the opening military engagement of the American Revolutionary War and immortalizing the stand as "the shot heard \'round the world."';
    } else if (theme === '1776-revolution') {
        overviewText = `This historical visual presentation documents key events, leaders, and pivotal turning points surrounding ${docTitle}, preserving the revolutionary ideals and sacrifices that established modern constitutional democracy.`;
    } else if (theme === 'auth-zerotrust-security') {
        overviewText = `Architectural and cryptographic specification for ${docTitle}, detailing end-to-end zero-trust verification, hardware enclave signing, and low-latency token rotation.`;
    } else if (theme === 'ai-machine-learning') {
        overviewText = `Multi-modal neural architecture and pipeline synthesis for ${docTitle}, illustrating tensor attention flows, dynamic agent orchestration, and sub-50ms inference.`;
    } else {
        overviewText = `Comprehensive visual archive and technical analysis for ${docTitle}, providing executive synthesis, media reconstruction, and operational details.`;
    }

    sections.push({
        id: `sec-p-${Date.now()}-1`,
        type: 'paragraph',
        content: overviewText
    });

    // 3. Prominent Media Section: Editorial Image or Video
    let mediaSection: MarkdownSection;
    if (kind === 'video') {
        mediaSection = generateMotivatedVideoSection(theme, prompt, docTitle);
        if (isLexington) {
            mediaSection.videoTitle = 'The Battle of Lexington: Tactical Reenactment & Skirmish Timeline';
            mediaSection.caption = 'Cinematic multi-angle reconstruction of Captain John Parker’s minutemen facing Major Pitcairn’s Redcoats at sunrise on Lexington Green.';
            mediaSection.description = mediaSection.caption;
            mediaSection.visualPrompt = 'Cinematic historical reenactment of the Battle of Lexington Green at sunrise on April 19, 1775, 4k ultra-high definition, dramatic morning mist, colonial minutemen facing British Regulars, musket flashes, slow motion';
            mediaSection.attribution = 'Scratchbox Studio • Google Veo 2 Temporal Synthesis';
            mediaSection.dateTag = 'April 19, 1775 • Lexington, MA';
            mediaSection.timelineEvents = [
                { time: '00:00', label: 'Assembly at Buckman Tavern', description: 'Captain Parker musters 77 minutemen as alarm bell rings from the meetinghouse belfry.' },
                { time: '00:45', label: 'British Advance & Confrontation', description: 'Major Pitcairn’s Light Infantry arrives in crimson ranks and orders the militia to disperse.' },
                { time: '01:30', label: 'The Shot Heard \'Round the World', description: 'A shot rings out from an unknown source, provoking a fatal British volley.' },
                { time: '02:45', label: 'Militia Regroup & Concord March', description: 'Minutemen withdraw in disciplined order to rally at Concord North Bridge.' }
            ];
        }
    } else {
        mediaSection = generateMotivatedEditorialImageSection(theme, prompt, docTitle);
        if (isLexington) {
            mediaSection.imageTitle = 'The Battle of Lexington Green: The First Shot (April 19, 1775)';
            mediaSection.caption = 'Captain John Parker and colonial minutemen stand resolute against British Regulars at sunrise on Lexington Green as the "shot heard \'round the world" ignites the American Revolution.';
            mediaSection.description = mediaSection.caption;
            mediaSection.attribution = 'Historical Masterpiece • Lexington Historical Society • Nano Banana Pro';
            mediaSection.dateTag = 'April 19, 1775 • Lexington, MA';
            mediaSection.visualPrompt = 'Museum masterwork oil painting of the Battle of Lexington Green at dawn, April 19, 1775. Captain John Parker and colonial minutemen with flintlock muskets facing ranks of British Regulars in crimson coats, drifting musket smoke in cold morning air, Buckman Tavern in background, dramatic sunrise light breaking through mist, 8k masterpiece.';
        }
    }
    sections.push(mediaSection);

    // 4. Inline Markdown Media Anchor
    const mediaUrl = (kind === 'video' ? (mediaSection.videoUrl || mediaSection.imageUrl) : mediaSection.imageUrl) || 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&w=1600&q=85';
    const mediaAlt = mediaSection.imageTitle || mediaSection.videoTitle || docTitle;
    const mediaCaption = mediaSection.caption || overviewText;

    sections.push({
        id: `sec-inline-media-${Date.now()}`,
        type: 'paragraph',
        content: kind === 'video'
            ? `**Cinematic Video Reconstruction:**\n\n![${mediaAlt}](${mediaSection.thumbnailUrl || mediaUrl})\n\n*Figure 1: ${mediaCaption}*\n\n[▶ Play Full-Length Reconstruction (${mediaSection.duration || '03:15'})](${mediaUrl})`
            : `![${mediaAlt}](${mediaUrl})\n\n*Figure 1: ${mediaCaption}*`
    });

    // 5. Heading 2: Analysis & Eyewitness Perspectives
    sections.push({
        id: `sec-h2-${Date.now()}-1`,
        type: 'heading',
        level: 2,
        content: isLexington
            ? '2. Eyewitness Accounts & Tactical Disposition'
            : '2. Detailed Analysis & Key Principles'
    });

    // 6. Historic Callout / Quote
    if (isLexington) {
        sections.push({
            id: `sec-quote-${Date.now()}-1`,
            type: 'quote',
            content: '“Stand your ground. Don’t fire unless fired upon, but if they mean to have a war, let it begin here.”\n— Captain John Parker, Lexington Militia, April 19, 1775'
        });
        sections.push({
            id: `sec-p-${Date.now()}-2`,
            type: 'paragraph',
            content: 'The confrontation lasted only a few minutes. Captain Parker, realizing his small force was vastly outnumbered, ordered his men to disperse and not fire. However, amid the shouting and confusion, a shot was discharged. The British soldiers, without direct orders, fired a devastating volley and charged with bayonets. Eight Lexington militiamen were killed and ten wounded, while one British soldier was lightly injured.'
        });
    } else {
        sections.push({
            id: `sec-callout-${Date.now()}-1`,
            type: 'callout',
            calloutType: 'info',
            calloutTitle: `${docTitle} — Core Insight`,
            content: `Visual and narrative synthesis grounded in empirical reference data, demonstrating ${docTitle} across multi-modal surfaces.`
        });
    }

    // 7. Tactical / Data Table
    if (isLexington) {
        sections.push({
            id: `sec-tbl-${Date.now()}-1`,
            type: 'table',
            tableHeaders: ['Combatant Force', 'Commanding Officer', 'Estimated Strength', 'Casualties at Lexington', 'Primary Armament'],
            tableRows: [
                ['Lexington Militia & Minutemen', 'Capt. John Parker', '~77 men', '8 killed, 10 wounded', 'Flintlock fowling pieces & muskets'],
                ['British Light Infantry & Regulars', 'Maj. John Pitcairn & Lt. Col. Francis Smith', '~250 advance guard (700 total column)', '1 wounded (Pvt. Johnson)', '.75 caliber Brown Bess muskets & bayonets']
            ]
        });
    } else {
        sections.push({
            id: `sec-tbl-${Date.now()}-1`,
            type: 'table',
            tableHeaders: ['Metric / Pillar', 'Target Value', 'Operational Impact', 'Status'],
            tableRows: [
                ['Visual Fidelity', '100% High-DPI Vector/Raster', 'Sub-pixel clarity across all canvas viewports', 'Active'],
                ['Generation Latency', '< 120ms local / < 1.4s cloud', 'Zero blocking interaction on studio canvas', 'Optimized'],
                ['Multi-Modal Support', 'Markdown + Image + Video + 3D', 'Unified primitive architecture', 'Production']
            ]
        });
    }

    // 8. Citations / Historical Attribution
    if (isLexington) {
        sections.push({
            id: `sec-cit-${Date.now()}-1`,
            type: 'citation',
            citationItems: [
                {
                    id: `cit-1-${Date.now()}`,
                    sourceTitle: 'Depositions of the Lexington Minutemen, April 25, 1775',
                    author: 'Captain John Parker and 33 members of the Lexington Company',
                    archiveName: 'Massachusetts Provincial Congress, Watertown, MA',
                    year: '1775',
                    url: 'https://www.masshist.org',
                    verified: true,
                    badgeText: 'Primary Archival Source'
                },
                {
                    id: `cit-2-${Date.now()}`,
                    sourceTitle: 'Paul Revere’s Three Accounts of His Famous Ride',
                    author: 'Paul Revere',
                    archiveName: 'Massachusetts Historical Society Proceedings',
                    year: '1775',
                    url: 'https://www.masshist.org',
                    verified: true,
                    badgeText: 'Primary Archival Source'
                }
            ]
        });
    } else {
        sections.push(generateMotivatedCitationSection(theme, prompt));
    }

    return {
        title: docTitle,
        subtitle: isLexington
            ? 'Visual Archival Documentation & Historical Reconstruction (April 19, 1775)'
            : `Editorial Visual Archive & Narrative Documentation for ${docTitle}`,
        author: docAuthor,
        lastUpdated: 'Just now',
        tags: isLexington
            ? ['History', 'AmericanRevolution', 'Lexington', '1775', 'Minutemen', 'VisualArchive']
            : ['VisualArchive', 'Editorial', 'MediaSynthesis', 'Design'],
        sections: ensureCompleteSections(sections, docTitle)
    };
}

