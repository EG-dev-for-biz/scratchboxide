/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import type { GeminiGenerateRequest, GroundingMetadata } from '../../common/gemini-protocol';
import type {
    CanvasArtifact,
    CitationItem,
    CodeFileTab,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    PrimitiveType,
    SandboxTemplate,
    Scene3DData
} from '../../browser/generative-canvas/canvas-types';
import {
    synthesizeComprehensiveDocument as synthesizeDocumentFromEngine,
    ensureCompleteSections,
    synthesizeMediaDocument
} from '../../browser/generative-canvas/document-synthesis-engine';
import { synthesizeContextual3DScene } from '../../browser/generative-canvas/procedural-3d-synthesizer';

type CustomMesh = NonNullable<Scene3DData['customMeshes']>[number];

/** Neutral default attribution for synthesized documents. */
export const DEFAULT_DOCUMENT_AUTHOR = 'Scratchbox Studio';

/**
 * Artifact synthesis: turns raw model output (JSON code blocks, markdown, runnable code) into a
 * structured `CanvasArtifact`, with deterministic fallbacks for documents, 3D scenes, graphs and
 * live code sandboxes when the model returns prose only.
 */

/**
 * Convert markdown string to structured MarkdownSection items.
 */
export function markdownStringToSections(md: string): MarkdownSection[] {
    const lines = md.split('\n');
    const sections: MarkdownSection[] = [];
    let currentParagraph: string[] = [];
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableRows: string[][] = [];
    let currentChecklist: Array<{ id: string; text: string; done: boolean }> = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines: string[] = [];

    const flushParagraph = () => {
        if (currentParagraph.length > 0) {
            const firstLine = currentParagraph[0].trim();
            // Check for explicit GitHub/Obsidian style callout syntax on first line: > [!NOTE], > [!TIP], > [!INFO], > [!WARNING], > [!IMPORTANT]
            const calloutMatch = firstLine.match(/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\](?:\s+(.+))?$/i);

            if (calloutMatch) {
                const rawType = calloutMatch[1].toLowerCase();
                let calloutType: 'info' | 'tip' | 'warning' = 'info';
                if (rawType === 'tip') calloutType = 'tip';
                else if (rawType === 'warning' || rawType === 'caution' || rawType === 'important') calloutType = 'warning';

                const rawTitle = calloutMatch[2] ? calloutMatch[2].replace(/^[-:\s]+/, '').trim() : '';
                const defaultTitle = rawType.charAt(0).toUpperCase() + rawType.slice(1);
                const calloutTitle = rawTitle || defaultTitle;

                const bodyLines = currentParagraph.slice(1).map(l => l.replace(/^>\s*/, '').trim()).filter(Boolean);
                const calloutBody = bodyLines.join(' ').trim();

                sections.push({
                    id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    type: 'callout',
                    calloutType,
                    calloutTitle,
                    content: calloutBody || calloutTitle
                });
            } else if (firstLine.startsWith('>')) {
                // Check if blockquote has a bold title prefix like: > **Primary Source Callout:** ... or > **Key Insight**: ...
                const cleanQuote = currentParagraph.map(l => l.replace(/^>\s*/, '').trim()).join(' ').trim();
                const boldCalloutMatch = cleanQuote.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i);
                if (boldCalloutMatch) {
                    const calloutTitle = boldCalloutMatch[1].trim();
                    const calloutBody = boldCalloutMatch[2].trim() || cleanQuote;
                    sections.push({
                        id: `sec-callout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'callout',
                        calloutType: 'info',
                        calloutTitle,
                        content: calloutBody
                    });
                } else if (cleanQuote) {
                    sections.push({
                        id: `sec-quote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'quote',
                        content: cleanQuote
                    });
                }
            } else {
                // Standard rich paragraph (NOT converted to callouts)
                const text = currentParagraph.join(' ').trim();
                if (text) {
                    sections.push({
                        id: `sec-p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'paragraph',
                        content: text
                    });
                }
            }
            currentParagraph = [];
        }
    };

    const flushTable = () => {
        if (inTable && tableHeaders.length > 0) {
            sections.push({
                id: `sec-tbl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'table',
                tableHeaders,
                tableRows
            });
            tableHeaders = [];
            tableRows = [];
            inTable = false;
        }
    };

    const flushChecklist = () => {
        if (currentChecklist.length > 0) {
            sections.push({
                id: `sec-chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'checklist',
                checklistItems: currentChecklist
            });
            currentChecklist = [];
        }
    };

    const flushCodeBlock = () => {
        if (inCodeBlock) {
            sections.push({
                id: `sec-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'code',
                codeLanguage: codeLanguage || 'typescript',
                content: codeLines.join('\n')
            });
            codeLines = [];
            codeLanguage = '';
            inCodeBlock = false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Handle fenced code blocks
        if (trimmed.startsWith('```')) {
            if (inCodeBlock) {
                flushCodeBlock();
            } else {
                flushParagraph();
                flushTable();
                flushChecklist();
                inCodeBlock = true;
                codeLanguage = trimmed.slice(3).trim();
                codeLines = [];
            }
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(line);
            continue;
        }

        // Headings (#, ##, ###, ####, etc.)
        if (trimmed.startsWith('#')) {
            flushParagraph();
            flushTable();
            flushChecklist();
            const levelMatch = trimmed.match(/^(#{1,6})\s*(.*)$/);
            if (levelMatch) {
                const level = Math.min(3, Math.max(1, levelMatch[1].length)) as (1 | 2 | 3);
                const headingContent = levelMatch[2].trim();
                if (headingContent) {
                    sections.push({
                        id: `sec-h${level}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        type: 'heading',
                        level,
                        content: headingContent
                    });
                }
            }
        }
        // Checklist items (- [ ] or - [x] or * [ ] or * [x])
        else if (/^[-*]\s+\[([ xX])\]\s+(.+)$/.test(trimmed)) {
            flushParagraph();
            flushTable();
            const checkMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
            if (checkMatch) {
                const done = checkMatch[1].toLowerCase() === 'x';
                const text = checkMatch[2].trim();
                currentChecklist.push({
                    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    text,
                    done
                });
            }
        }
        // Tables (| col 1 | col 2 |)
        else if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            flushParagraph();
            flushChecklist();
            const cells = trimmed
                .split('|')
                .map(c => c.trim())
                .filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);

            if (cells.every(c => /^:?-+:?$/.test(c))) {
                // separator line
                inTable = true;
            } else if (!inTable && tableHeaders.length === 0) {
                tableHeaders = cells;
            } else {
                inTable = true;
                tableRows.push(cells);
            }
        }
        // Explicit callout header line (e.g. > [!NOTE] or > [!TIP])
        else if (/^>\s*\[!(NOTE|TIP|INFO|WARNING|IMPORTANT|CAUTION)\]/i.test(trimmed)) {
            flushParagraph();
            flushTable();
            flushChecklist();
            currentParagraph.push(trimmed);
        }
        // Blank lines flush active paragraph/table/checklist
        else if (trimmed === '') {
            flushParagraph();
            flushTable();
            flushChecklist();
        } else {
            if (inTable) {
                flushTable();
            }
            if (currentChecklist.length > 0) {
                flushChecklist();
            }
            currentParagraph.push(trimmed);
        }
    }

    flushParagraph();
    flushTable();
    flushChecklist();
    flushCodeBlock();

    return sections.length > 0
        ? sections
        : [
              {
                  id: `sec-default`,
                  type: 'paragraph',
                  content: md.slice(0, 2000)
              }
          ];
}

/**
 * Synthesizes rich interactive React components tailored to user intent.
 */
export function generateContextualReactApp(prompt: string, title: string): string {
    const lower = (prompt + ' ' + title).toLowerCase();
    
    if (lower.includes('calculator')) {
        return `import React, { useState } from 'react';
import { Calculator as CalcIcon, History, Trash2, ArrowLeft } from 'lucide-react';

export default function App() {
  const [display, setDisplay] = useState('0');
  const [equation, setEquation] = useState('');
  const [history, setHistory] = useState<string[]>([]);

  const handleDigit = (digit: string) => {
    setDisplay(prev => (prev === '0' || prev === 'Error' ? digit : prev + digit));
  };

  const handleOp = (op: string) => {
    setEquation(\`\${display} \${op} \`);
    setDisplay('0');
  };

  const handleClear = () => {
    setDisplay('0');
    setEquation('');
  };

  const handleCalculate = () => {
    try {
      const fullExpr = equation + display;
      const sanitized = fullExpr.replace(/[^0-9+\\-*\\/().]/g, '');
      const result = Function(\`'use strict'; return (\${sanitized})\`)();
      const resStr = String(Math.round(result * 100000000) / 100000000);
      setHistory(prev => [\`\${fullExpr} = \${resStr}\`, ...prev.slice(0, 9)]);
      setDisplay(resStr);
      setEquation('');
    } catch {
      setDisplay('Error');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 text-zinc-100 p-4 font-sans select-none">
      <div className="w-full max-w-sm bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between mb-4 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
            <CalcIcon className="w-4 h-4" />
            <span>Interactive Calculator</span>
          </div>
          <button onClick={() => setHistory([])} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
            <Trash2 className="w-3 h-3" /> Clear History
          </button>
        </div>

        <div className="bg-zinc-950/80 rounded-2xl p-4 mb-5 border border-zinc-800/80 text-right">
          <div className="text-xs text-zinc-500 h-5 overflow-hidden">{equation}</div>
          <div className="text-4xl font-extrabold tracking-tight text-white overflow-x-auto">{display}</div>
        </div>

        <div className="grid grid-cols-4 gap-2.5">
          <button onClick={handleClear} className="p-3.5 rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 font-bold text-sm">C</button>
          <button onClick={() => setDisplay(prev => prev.length > 1 ? prev.slice(0, -1) : '0')} className="p-3.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-sm flex items-center justify-center"><ArrowLeft className="w-4 h-4" /></button>
          <button onClick={() => handleOp('%')} className="p-3.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold text-sm">%</button>
          <button onClick={() => handleOp('/')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">÷</button>

          {['7', '8', '9'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('*')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">×</button>

          {['4', '5', '6'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('-')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">−</button>

          {['1', '2', '3'].map(d => <button key={d} onClick={() => handleDigit(d)} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">{d}</button>)}
          <button onClick={() => handleOp('+')} className="p-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm">+</button>

          <button onClick={() => handleDigit('0')} className="col-span-2 p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-medium text-lg">0</button>
          <button onClick={() => handleDigit('.')} className="p-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80 text-zinc-100 font-bold text-lg">.</button>
          <button onClick={handleCalculate} className="p-3.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-lg shadow-lg shadow-blue-500/25">=</button>
        </div>

        {history.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800/80">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1.5 font-medium">
              <History className="w-3.5 h-3.5" /> Recent Calculations
            </div>
            <div className="space-y-1 max-h-24 overflow-y-auto text-xs text-zinc-400">
              {history.map((h, i) => (
                <div key={i} className="flex justify-between py-0.5 px-1.5 rounded hover:bg-zinc-800/40">
                  <span>{h}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}`;
    }

    if (lower.includes('lexington') || lower.includes('concord') || lower.includes('1776') || lower.includes('revolution') || lower.includes('battle')) {
        return `import React, { useState } from 'react';
import { Compass, Clock, Award, Flag, MapPin, ChevronRight } from 'lucide-react';
import confetti from 'canvas-confetti';

interface BattlePhase {
  id: string;
  time: string;
  title: string;
  location: string;
  description: string;
  significance: string;
  colonistCasualties: number;
  britishCasualties: number;
  tacticalAdvantage: 'colonists' | 'british' | 'stalemate';
}

const PHASES: BattlePhase[] = [
  {
    id: 'phase-1',
    time: 'April 18, 10:00 PM',
    title: 'The Midnight Ride',
    location: 'Boston to Lexington',
    description: 'Paul Revere and William Dawes set out on horseback to sound the alarm that British regulars were marching toward Concord.',
    significance: 'Allowed colonial militia (Minutemen) to muster and conceal military stores.',
    colonistCasualties: 0,
    britishCasualties: 0,
    tacticalAdvantage: 'colonists'
  },
  {
    id: 'phase-2',
    time: 'April 19, 5:00 AM',
    title: 'The Shot Heard \\'Round the World',
    location: 'Lexington Common',
    description: 'Captain John Parker and roughly 77 Minutemen stood on the green. An unknown shot rang out, followed by British volleys.',
    significance: 'First military confrontation marking the official outbreak of the American Revolutionary War.',
    colonistCasualties: 8,
    britishCasualties: 1,
    tacticalAdvantage: 'british'
  },
  {
    id: 'phase-3',
    time: 'April 19, 9:00 AM',
    title: 'The Stand at North Bridge',
    location: 'Concord, Massachusetts',
    description: 'Hundreds of Massachusetts militia under Major John Buttrick engaged British light infantry holding North Bridge.',
    significance: 'First time colonial troops advanced in formation against British regulars and forced a retreat.',
    colonistCasualties: 2,
    britishCasualties: 3,
    tacticalAdvantage: 'colonists'
  },
  {
    id: 'phase-4',
    time: 'April 19, 12:00 PM - 7:00 PM',
    title: 'The Running Battle along Battle Road',
    location: 'Concord to Charlestown',
    description: 'Over 4,000 militia swarmed stone walls and tree lines, relentlessly harrying Colonel Smith\\'s retreating column.',
    significance: 'Decisive tactical defeat of the British expedition, leading directly to the Siege of Boston.',
    colonistCasualties: 39,
    britishCasualties: 269,
    tacticalAdvantage: 'colonists'
  }
];

export default function App() {
  const [activePhaseIndex, setActivePhaseIndex] = useState(0);

  const currentPhase = PHASES[activePhaseIndex];

  const handleSelectPhase = (index: number) => {
    setActivePhaseIndex(index);
    if (index === PHASES.length - 1) {
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.6 } });
    }
  };

  const totalColonist = PHASES.reduce((acc, p) => acc + p.colonistCasualties, 0);
  const totalBritish = PHASES.reduce((acc, p) => acc + p.britishCasualties, 0);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100 p-6 font-sans">
      <div className="max-w-4xl mx-auto w-full space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-xl backdrop-blur">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs font-semibold border border-amber-500/20">
              <Compass className="w-3.5 h-3.5" />
              <span>April 19, 1775 • Massachusetts Bay</span>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Battles of Lexington & Concord: Live Timeline Explorer</h1>
            <p className="text-sm text-zinc-400">Interactive military timeline, tactical casualty analysis, and pivotal battle phases.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center p-3 bg-zinc-950/60 rounded-xl border border-zinc-800">
              <div className="text-xs text-zinc-400 font-medium">Colonial Militia</div>
              <div className="text-xl font-bold text-blue-400">{totalColonist} lost</div>
            </div>
            <div className="text-center p-3 bg-zinc-950/60 rounded-xl border border-zinc-800">
              <div className="text-xs text-zinc-400 font-medium">British Regulars</div>
              <div className="text-xl font-bold text-rose-400">{totalBritish} casualties</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {PHASES.map((p, idx) => {
            const isActive = idx === activePhaseIndex;
            return (
              <button
                key={p.id}
                onClick={() => handleSelectPhase(idx)}
                className={\`p-4 rounded-xl text-left border transition-all \${
                  isActive
                    ? 'bg-blue-600/15 border-blue-500/50 text-white shadow-lg shadow-blue-500/10'
                    : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                }\`}
              >
                <div className="text-xs font-semibold text-zinc-500 mb-1">Phase 0{idx + 1}</div>
                <div className="font-bold text-sm text-zinc-100 line-clamp-1">{p.title}</div>
                <div className="text-xs text-zinc-400 mt-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {p.time}
                </div>
              </button>
            );
          })}
        </div>

        <div className="p-6 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-zinc-800 gap-2">
            <div>
              <div className="text-xs text-blue-400 font-medium uppercase tracking-wider">{currentPhase.time}</div>
              <h2 className="text-xl font-bold text-white mt-0.5">{currentPhase.title}</h2>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 mt-1">
                <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                <span>{currentPhase.location}</span>
              </div>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700/80 text-xs">
              <Flag className="w-3.5 h-3.5 text-amber-400" />
              <span>Advantage: <strong className="text-white capitalize">{currentPhase.tacticalAdvantage}</strong></span>
            </div>
          </div>

          <p className="text-zinc-300 text-sm leading-relaxed">{currentPhase.description}</p>

          <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800/80 flex items-start gap-3">
            <Award className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Historical Significance</div>
              <div className="text-sm text-zinc-300 mt-0.5">{currentPhase.significance}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="p-3 bg-zinc-950/50 rounded-xl border border-zinc-800 flex items-center justify-between">
              <span className="text-xs text-zinc-400">Minutemen Casualties</span>
              <span className="text-sm font-bold text-blue-400">{currentPhase.colonistCasualties}</span>
            </div>
            <div className="p-3 bg-zinc-950/50 rounded-xl border border-zinc-800 flex items-center justify-between">
              <span className="text-xs text-zinc-400">British Column Casualties</span>
              <span className="text-sm font-bold text-rose-400">{currentPhase.britishCasualties}</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
            <button
              onClick={() => handleSelectPhase(Math.max(0, activePhaseIndex - 1))}
              disabled={activePhaseIndex === 0}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 text-zinc-200 transition"
            >
              Previous Phase
            </button>
            <div className="text-xs text-zinc-500 font-medium">Phase {activePhaseIndex + 1} of {PHASES.length}</div>
            <button
              onClick={() => handleSelectPhase(Math.min(PHASES.length - 1, activePhaseIndex + 1))}
              disabled={activePhaseIndex === PHASES.length - 1}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white transition flex items-center gap-1.5"
            >
              <span>Next Phase</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}`;
    }

    // Generic modern interactive web preview
    return `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);
  const [intensity, setIntensity] = useState(75);
  const [activeTab, setActiveTab] = useState<'overview' | 'metrics' | 'controls'>('overview');

  const handleAction = () => {
    setCount(prev => prev + 1);
    confetti({ particleCount: 50, spread: 60, origin: { y: 0.7 } });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white font-sans">
      <div className="w-full max-w-lg p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6">
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">${title.replace(/"/g, '\\"')}</h1>
              <p className="text-xs text-zinc-400">Live Interactive Scratchbox Preview</p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Ready
          </span>
        </div>

        <div className="flex gap-2 p-1 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          {(['overview', 'metrics', 'controls'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={\`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold capitalize transition-all \${
                activeTab === tab
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
                  : 'text-zinc-400 hover:text-zinc-200'
              }\`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="p-4 bg-zinc-950/50 rounded-2xl border border-zinc-800/50 flex items-center justify-around">
              <div>
                <div className="text-xs text-zinc-500 font-medium">Interactions</div>
                <div className="text-3xl font-extrabold text-blue-400">{count}</div>
              </div>
              <div className="h-8 w-px bg-zinc-800"></div>
              <div>
                <div className="text-xs text-zinc-500 font-medium">Intensity</div>
                <div className="text-3xl font-extrabold text-emerald-400">{intensity}%</div>
              </div>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              This interactive component is running live inside Scratchbox Canvas via Babel Standalone and React 19. All states, events, and styling are hot-reloaded automatically.
            </p>
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="space-y-3">
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">FPS / Render Rate</span>
              <span className="text-emerald-400 font-bold">60.0 fps</span>
            </div>
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">WASM Runtime</span>
              <span className="text-blue-400 font-bold">Active</span>
            </div>
            <div className="p-3 bg-zinc-950/40 rounded-xl border border-zinc-800 flex justify-between text-xs">
              <span className="text-zinc-400">Component Mount</span>
              <span className="text-zinc-300 font-mono">App.tsx</span>
            </div>
          </div>
        )}

        {activeTab === 'controls' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-zinc-400">
                <span>Simulation Parameter</span>
                <span>{intensity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={intensity}
                onChange={e => setIntensity(Number(e.target.value))}
                className="w-full accent-blue-500 bg-zinc-800 rounded-lg cursor-pointer"
              />
            </div>
          </div>
        )}

        <button
          onClick={handleAction}
          className="w-full py-3 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
        >
          <Play className="w-4 h-4 fill-current" />
          <span>Trigger Interactive Event ({count})</span>
        </button>
      </div>
    </div>
  );
}`;
}

/**
 * Extracts runnable code blocks from AI output or synthesizes an interactive live sandbox
 * with viewMode: 'preview' for immediate hot-reloading execution.
 */
export function extractCodeSandboxArtifact(
    prompt: string,
    cleanContent: string,
    activeArtifact?: CanvasArtifact
): { artifact: CanvasArtifact; hasRunnableCode: boolean } | null {
    // Match all fenced code blocks in cleanContent
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g;
    const matches: Array<{ language: string; content: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(cleanContent)) !== null) {
        const rawLang = (match[1] || '').trim().toLowerCase();
        const code = match[2];
        if (code && code.trim().length > 0) {
            matches.push({ language: rawLang, content: code.trim() });
        }
    }

    const runnableMatches = matches.filter(m => 
        ['tsx', 'jsx', 'react', 'html', 'htm', 'svg', 'javascript', 'js', 'typescript', 'ts', 'css', 'python', 'py'].includes(m.language) ||
        /import\s+React|export\s+default\s+function|<\w+[\s>]|<!DOCTYPE\s+html|<svg/i.test(m.content)
    );

    const isSandboxExplicit = /preview|sandbox|app|web\s*app|landing\s*page|calculator|game|dashboard|component|widget|mockup|ui|react|html|css|javascript|typescript|python|interactive|simulator|timeline/i.test(prompt);

    if (runnableMatches.length === 0 && !isSandboxExplicit) {
        return null;
    }

    const timestamp = new Date().toISOString();
    let title = extractDocumentTitle(prompt, 'Interactive Live Preview');
    if (title.toLowerCase().startsWith('strategic') || title.toLowerCase().startsWith('project specification')) {
        title = 'Interactive Live Preview';
    }

    let template: SandboxTemplate = 'react';
    const files: CodeFileTab[] = [];
    const dependencies: Record<string, string> = {
        'lucide-react': '^0.468.0',
        'canvas-confetti': '^1.9.3'
    };

    if (runnableMatches.length > 0) {
        const hasReact = runnableMatches.some(m => ['tsx', 'jsx', 'react'].includes(m.language) || (['typescript', 'ts', 'javascript', 'js'].includes(m.language) && /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content)));
        const hasHtml = runnableMatches.some(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
        const hasPython = runnableMatches.some(m => ['python', 'py'].includes(m.language));

        if (hasReact || (!hasHtml && !hasPython)) {
            template = 'react';
            let appFound = false;
            runnableMatches.forEach((m, idx) => {
                const isCodeReact = ['tsx', 'jsx', 'react', 'typescript', 'ts', 'javascript', 'js'].includes(m.language) || /import\s+React|export\s+default\s+function|<\w+[\s>]/.test(m.content);
                if (isCodeReact && !appFound) {
                    files.push({
                        id: 'file-app',
                        name: 'App.tsx',
                        language: 'react',
                        content: m.content,
                        isEntry: true
                    });
                    appFound = true;
                } else if (m.language === 'css') {
                    files.push({
                        id: `file-css-${idx}`,
                        name: 'styles.css',
                        language: 'css',
                        content: m.content
                    });
                } else {
                    files.push({
                        id: `file-${idx}`,
                        name: `Component_${idx}.tsx`,
                        language: 'react',
                        content: m.content
                    });
                }
            });
            if (!files.some(f => f.name === 'styles.css')) {
                files.push({
                    id: 'file-css-default',
                    name: 'styles.css',
                    language: 'css',
                    content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; }`
                });
            }
        } else if (hasHtml) {
            template = 'vanilla-html';
            const htmlMatch = runnableMatches.find(m => ['html', 'htm', 'svg'].includes(m.language) || m.content.includes('<!DOCTYPE') || m.content.includes('<html') || m.content.trim().startsWith('<svg'));
            let htmlContent = htmlMatch ? htmlMatch.content : '<div>Live Preview</div>';
            if (htmlMatch?.language === 'svg' || htmlContent.trim().startsWith('<svg')) {
                htmlContent = `<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #09090b; color: #fff; }\n    svg { max-width: 90vw; max-height: 85vh; filter: drop-shadow(0 20px 30px rgba(0,0,0,0.5)); }\n  </style>\n</head>\n<body>\n  ${htmlContent}\n</body>\n</html>`;
            }
            files.push({
                id: 'file-index',
                name: 'index.html',
                language: 'html',
                content: htmlContent,
                isEntry: true
            });
            const cssMatch = runnableMatches.find(m => m.language === 'css');
            if (cssMatch) {
                files.push({
                    id: 'file-styles',
                    name: 'styles.css',
                    language: 'css',
                    content: cssMatch.content
                });
            }
        } else if (hasPython) {
            template = 'python';
            const pyMatch = runnableMatches.find(m => ['python', 'py'].includes(m.language));
            files.push({
                id: 'file-main-py',
                name: 'main.py',
                language: 'python',
                content: pyMatch?.content || '# Live Python WASM Sandbox\nprint("Hello from Scratchbox!")',
                isEntry: true
            });
        }
    }

    // If no code files extracted but isSandboxExplicit is true, synthesize a rich interactive application
    if (files.length === 0) {
        template = 'react';
        files.push({
            id: 'file-app',
            name: 'App.tsx',
            language: 'react',
            content: generateContextualReactApp(prompt, title),
            isEntry: true
        });
        files.push({
            id: 'file-css',
            name: 'styles.css',
            language: 'css',
            content: `/* Studio Sandbox Styles */\nbody { margin: 0; padding: 0; }`
        });
    }

    const sandboxData: LiveCodeSandboxData = {
        title,
        subtitle: `Live interactive preview generated for ${title}`,
        template,
        files,
        activeFileId: files.find(f => f.isEntry)?.id || files[0]?.id,
        viewMode: 'preview',
        viewportMode: 'desktop',
        autoRun: true,
        dependencies
    };

    const artifact: CanvasArtifact = {
        id: (activeArtifact?.type === 'live-code-sandbox' ? activeArtifact.id : undefined) || `art-sandbox-${Date.now()}`,
        type: 'live-code-sandbox',
        title,
        summary: sandboxData.subtitle || `Interactive live preview for ${title}`,
        version: (activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.version || 1) + 1 : 1),
        createdAt: timestamp,
        data: sandboxData
    };

    return {
        artifact,
        hasRunnableCode: runnableMatches.length > 0
    };
}

/**
 * Extract a rich, specific document title from prompt context, avoiding generic strings.
 */
export function extractDocumentTitle(prompt: string, fallback: string = 'Strategic Specification & Notes'): string {
    if (/1776/i.test(prompt)) {
        return 'The Profound Significance of 1776: Liberty, Revolution, and Democratic Thought';
    }
    if (/auth(entication)?|oauth|jwt|security|identity|zero[- ]trust/i.test(prompt)) {
        return 'Technical Specification: Scalable Authentication & Zero-Trust Identity Infrastructure';
    }
    if (/proposal|roadmap|business plan/i.test(prompt)) {
        return 'Executive Project Proposal & Strategic Roadmap';
    }
    const cleanPrompt = prompt
        .replace(/^[\s\W]*(write|create|generate|draft|build|make)?\s*(a|an|the)?\s*(document|spec|specification|overview|notes|guide|report|proposal)?\s*(about|for|on|of)?\s*/i, '')
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
 * Synthesize a comprehensive, executive document hierarchy for any topic with rich 4D capabilities.
 */
export function synthesizeComprehensiveDocument(prompt: string, customTitle?: string): MarkdownDocumentData {
    return synthesizeDocumentFromEngine(prompt, customTitle || extractDocumentTitle(prompt));
}

/**
 * Parse JSON from AI model output or wrap markdown into a structured canvas primitive.
 */
export function parseOrSynthesizeArtifact(
    prompt: string,
    modelText: string,
    request: GeminiGenerateRequest,
    _mcpExecutions: McpExecutionState[],
    groundingMetadata?: GroundingMetadata
): CanvasArtifact {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const enrichGroundedCitations = (targetSections: MarkdownSection[]): MarkdownSection[] => {
        if (!groundingMetadata?.groundingChunks || groundingMetadata.groundingChunks.length === 0) {
            return targetSections;
        }
        const groundedCitations: CitationItem[] = groundingMetadata.groundingChunks
            .filter(c => c.web && (c.web.uri || c.web.title))
            .map((c, idx) => ({
                id: `cite-google-${idx + 1}-${Date.now()}`,
                sourceTitle: c.web?.title || c.web?.uri || `Google Search Grounded Reference ${idx + 1}`,
                url: c.web?.uri,
                verified: true,
                badgeText: 'Google Search Verified',
                archiveName: 'Google Search Grounding'
            }));

        if (groundedCitations.length === 0) return targetSections;

        const citeIdx = targetSections.findIndex(s => s.type === 'citation');
        if (citeIdx !== -1) {
            const existingSec = targetSections[citeIdx];
            const existingUrls = new Set((existingSec.citationItems || []).map(ci => ci.url).filter(Boolean));
            const merged = [
                ...groundedCitations,
                ...(existingSec.citationItems || []).filter(ci => !ci.url || !existingUrls.has(ci.url))
            ];
            const newSections = [...targetSections];
            newSections[citeIdx] = {
                ...existingSec,
                citationItems: merged
            };
            return newSections;
        } else {
            return [
                ...targetSections,
                {
                    id: `sec-citations-grounded-${Date.now()}`,
                    type: 'citation' as const,
                    citationItems: groundedCitations
                }
            ];
        }
    };

    // Extract clean text and JSON codeblock
    const cleanContent = modelText.replace(/```json[\s\S]*?```/g, '').trim() || modelText;
    const jsonMatch = modelText.match(/```json\s*([\s\S]*?)\s*```/) || modelText.match(/(\{[\s\S]*"type"[\s\S]*"data"[\s\S]*\})/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed) {
                let type = parsed.type as string;
                if (type === 'action-checklist') type = 'checklist';
                if (type === 'skills-manager') type = 'skills-hub';
                if (type === 'rendered-document' || type === 'document') type = 'markdown-document';
                if (type === 'flow-graph' || type === 'graph') type = 'node-graph';
                if (type === 'metrics' || type === 'dashboard') type = 'metric-dashboard';
                if (type === 'kanban') type = 'kanban-board';
                if (type === 'form') type = 'interactive-form';
                if (type === 'sandbox' || type === 'code-sandbox' || type === 'playground' || type === 'code-playground') type = 'live-code-sandbox';
                if (type === '3d' || type === 'scene-3d' || type === 'spatial-scene' || type === '3d_scene' || type === '3d-world' || type === 'r3f-scene') type = '3d-scene';

                let data = parsed.data;
                const isImageRequest = /create\s+(?:a\s+)?picture|generate\s+(?:a\s+)?picture|picture\s+of|draw\s+(?:a\s+)?picture|image\s+of|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|photo\s+of|photograph\s+of|illustration\s+of|painting\s+of|artwork\s+of|draw\s+(?:an?\s+)?image|make\s+(?:a\s+)?picture|make\s+(?:an?\s+)?image|\bpicture\b|\bphoto\b|\billustration\b|\bpainting\b/i.test(prompt);
                const isVideoRequest = /create\s+(?:a\s+)?video|generate\s+(?:a\s+)?video|video\s+of|make\s+(?:a\s+)?video|film\s+of|motion\s+clip|video\s+clip|record\s+(?:a\s+)?video|\bvideo\s+file\b|\bvideo\b/i.test(prompt);
                const isMediaRequest = isImageRequest || isVideoRequest;

                const isSandboxOrAppRequest = /preview|sandbox|app|web\s*app|landing\s*page|calculator|game|dashboard|component|widget|mockup|ui|react|html|css|javascript|typescript|python|interactive|simulator|timeline/i.test(prompt);
                const isDocExplicitRequest = /document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article|research\s+paper/i.test(prompt);

                const is3DActive = request.activeArtifact?.type === '3d-scene';
                const is3DFollowUp = !isMediaRequest && !isSandboxOrAppRequest && !isDocExplicitRequest && is3DActive && (
                    /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff|speed|camera|view|scene|heading|pitch|thrust|god\s*ray|crepuscular|light\s*shaft|contrail|control\s*surface|aileron|elevator|rudder|biome|terrain|atmosphere|scattering|shader/i.test(prompt) ||
                    prompt.toLowerCase().includes('animate') || prompt.toLowerCase().includes('fly') || prompt.toLowerCase().includes('play') || prompt.toLowerCase().includes('orbit') || prompt.toLowerCase().includes('motion') || prompt.toLowerCase().includes('takeoff')
                );

                if (is3DFollowUp && type !== '3d-scene') {
                    type = '3d-scene';
                } else if (isMediaRequest && type === '3d-scene') {
                    type = 'markdown-document';
                } else if (isSandboxOrAppRequest && type === '3d-scene') {
                    type = 'live-code-sandbox';
                }

                if (type === '3d-scene') {
                    const active3DData = is3DActive ? (request.activeArtifact?.data as Scene3DData) : undefined;
                    const isExplicitFlight = /plane|airplane|jet\s+aircraft|jet\s+transit|flight\s+corridor|aviation\s+sim/i.test(prompt) ||
                        (parsed.title && /plane|airplane|jet\s+aircraft|jet\s+transit/i.test(parsed.title)) ||
                        (data?.title && /plane|airplane|jet\s+aircraft|jet\s+transit/i.test(data.title));
                    
                    const isAnimateOnly = is3DFollowUp && !/new|change|build|create|switch/i.test(prompt) && /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff/i.test(prompt);

                    // Synthesize procedural scene baseline based on prompt & active context
                    const docContent = request.activeArtifact?.type === 'markdown-document'
                        ? (request.activeArtifact.data as MarkdownDocumentData)?.sections?.map(s => s.content || s.calloutTitle || '').join(' ')
                        : undefined;
                    const contextualSynthesized = synthesizeContextual3DScene(prompt, {
                        activeArtifact: request.activeArtifact,
                        chatHistory: request.chatHistory,
                        docTitle: request.activeArtifact?.title,
                        docContent
                    });

                    const effectiveTitle = parsed.title || data?.title || (isAnimateOnly && active3DData ? active3DData.title : contextualSynthesized.title);
                    const effectiveSubtitle = isAnimateOnly && isExplicitFlight
                        ? 'Animated 3D flight trajectory: dynamic bank, roll, and engine thrust active.'
                        : (parsed.summary || data?.subtitle || (isAnimateOnly && active3DData ? active3DData.subtitle : contextualSynthesized.subtitle));

                    const defaultObjects = isExplicitFlight
                        ? [
                            {
                                id: 'obj-aircraft-1',
                                content: {
                                    type: '3d-scene' as const,
                                    durableUri: 'internal:plane',
                                    mimeType: 'model/procedural-aircraft',
                                    metadata: { dims: { width: 12, height: 4, depth: 14 } }
                                },
                                space: {
                                    spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                                },
                                time: { startMs: 0, durationMs: 10000 },
                                lineage: { version: 1 }
                            }
                        ]
                        : (data?.objects || contextualSynthesized.objects || []);

                    const sceneTimeline = isAnimateOnly ? {
                        currentTimeMs: data?.timeline?.currentTimeMs ?? 0,
                        durationMs: data?.timeline?.durationMs ?? active3DData?.timeline?.durationMs ?? 10000,
                        isPlaying: true,
                        speed: data?.timeline?.speed ?? data?.timeline?.playbackSpeed ?? 1.0,
                        playbackSpeed: data?.timeline?.playbackSpeed ?? data?.timeline?.speed ?? 1.0,
                        isLooping: true,
                        ...(data?.timeline || {})
                    } : (data?.timeline || contextualSynthesized.timeline);

                    const sceneAnimation = isAnimateOnly
                        ? (data?.animation || (prompt.toLowerCase().includes('orbit') ? 'orbit' : 'flight'))
                        : (data?.animation || contextualSynthesized.animation);

                    const hasGodRays = /god\s*ray|crepuscular|light\s*shaft|volumetric\s*light|sunlight/i.test(prompt) || !!data?.features?.godRays || !!active3DData?.features?.godRays;
                    const hasAtmosphere = /atmosphere|scattering|rayleigh|mie|realistic\s*sky|sunlight/i.test(prompt) || !!data?.features?.atmosphericScattering || !!active3DData?.features?.atmosphericScattering;
                    const hasContrails = /contrail|vapor|vortex|wingtip\s*trail/i.test(prompt) || !!data?.features?.contrails || !!active3DData?.features?.contrails;
                    const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder|flap/i.test(prompt) || !!data?.features?.controlSurfaces || !!active3DData?.features?.controlSurfaces;
                    const hasTerrainBiomes = /biome|terrain|canyon|alpine|mountain|coastal|desert/i.test(prompt) || !!data?.features?.terrainBiomes || !!active3DData?.features?.terrainBiomes;

                    const effectiveFeatures = {
                        ...(contextualSynthesized.features || {}),
                        ...(active3DData?.features || {}),
                        ...(data?.features || {}),
                        ...(hasGodRays ? { godRays: true } : {}),
                        ...(hasAtmosphere ? { atmosphericScattering: true } : {}),
                        ...(hasContrails ? { contrails: true } : {}),
                        ...(hasControlSurfaces ? { controlSurfaces: true } : {}),
                        ...(hasTerrainBiomes ? { terrainBiomes: (data?.features?.terrainBiomes || active3DData?.features?.terrainBiomes || { biomeType: 'alpine' as const }) } : {})
                    };

                    const scene3DData: Scene3DData = {
                        title: effectiveTitle,
                        subtitle: effectiveSubtitle,
                        worldBranch: data?.worldBranch || active3DData?.worldBranch || contextualSynthesized.worldBranch,
                        sceneType: data?.sceneType || active3DData?.sceneType || contextualSynthesized.sceneType,
                        renderMode: data?.renderMode || active3DData?.renderMode || contextualSynthesized.renderMode || 'pbr',
                        cameraMode: data?.cameraMode || active3DData?.cameraMode || contextualSynthesized.cameraMode || 'orbit',
                        animation: sceneAnimation,
                        camera: data?.camera || active3DData?.camera || contextualSynthesized.camera || {
                            position: [15, 12, 20],
                            target: [0, 2, 0],
                            fov: 45
                        },
                        environment: {
                            lighting: 'daylight',
                            ground: true,
                            ...(active3DData?.environment || {}),
                            ...(contextualSynthesized.environment || {}),
                            ...(data?.environment || {}),
                            skybox: data?.environment?.skybox || ((hasAtmosphere || hasGodRays || isExplicitFlight || !!effectiveFeatures.godRays || !!effectiveFeatures.atmosphericScattering || !!effectiveFeatures.contrails) ? 'realistic-sky' : (active3DData?.environment?.skybox || contextualSynthesized.environment?.skybox || 'cyberpunk')),
                        },
                        timeline: sceneTimeline,
                        customScript: data?.customScript || data?.code || active3DData?.customScript || contextualSynthesized.customScript,
                        code: data?.code || data?.customScript || active3DData?.code || contextualSynthesized.code,
                        shaders: data?.shaders || active3DData?.shaders || contextualSynthesized.shaders,
                        features: effectiveFeatures,
                        customMeshes: (() => {
                            if (data?.customMeshes && Array.isArray(data.customMeshes) && data.customMeshes.length > 0) {
                                if (active3DData?.customMeshes && active3DData.customMeshes.length > 0) {
                                    const map = new Map<string, CustomMesh>();
                                    active3DData.customMeshes.forEach(m => map.set(m.id, m));
                                    (data.customMeshes as CustomMesh[]).forEach(m => map.set(m.id, m));
                                    return Array.from(map.values());
                                }
                                return data.customMeshes;
                            }
                            return active3DData?.customMeshes || contextualSynthesized.customMeshes;
                        })(),
                        objects: isExplicitFlight ? defaultObjects : (active3DData?.objects && active3DData.objects.length > 0 ? active3DData.objects : defaultObjects),
                        operatorStack: data?.operatorStack || active3DData?.operatorStack || [],
                        actionLog: data?.actionLog || active3DData?.actionLog || [],
                        sculptSettings: data?.sculptSettings || active3DData?.sculptSettings,
                        selectedMeshId: data?.selectedMeshId || active3DData?.selectedMeshId,
                        wasmPhysics: data?.wasmPhysics || active3DData?.wasmPhysics || contextualSynthesized.wasmPhysics,
                        geoAnchor: data?.geoAnchor || active3DData?.geoAnchor || contextualSynthesized.geoAnchor,
                        droneRoute: data?.droneRoute || active3DData?.droneRoute || contextualSynthesized.droneRoute
                    };
                    data = scene3DData;
                    parsed.title = effectiveTitle;
                }
                if (type === 'markdown-document') {
                    const fallbackTitle = request.activeArtifact?.title && request.activeArtifact.title !== 'Markdown Document'
                        ? request.activeArtifact.title
                        : extractDocumentTitle(prompt);

                    let effectiveDocTitle = parsed.title && parsed.title !== 'Markdown Document'
                        ? parsed.title
                        : (data?.title && data.title !== 'Markdown Document' ? data.title : fallbackTitle);

                    const isFullDocRequest = /write|create|generate|draft|paper|research|essay|article|report|guide|brief|memo|spec|overview|summary|proposal|1776|auth|history|battle/i.test(prompt) ||
                        !data?.sections || data.sections.length <= 1;
                    const isMinimal = /concise|minimal|text[- ]only|no[- ]media|no[- ]images?|no[- ]video/i.test(prompt);

                    if (typeof data === 'string') {
                        const sections = markdownStringToSections(data);
                        data = {
                            title: effectiveDocTitle,
                            subtitle: parsed.summary || 'Strategic overview',
                            sections
                        };
                    } else if (data && typeof data === 'object') {
                        let sections = Array.isArray(data.sections) ? data.sections : [];
                        if (sections.length === 0 && cleanContent) {
                            sections = markdownStringToSections(cleanContent);
                        }
                        data = {
                            ...data,
                            title: effectiveDocTitle,
                            sections
                        };
                    }

                    // If it's a full document request or sections are missing/incomplete, synthesize rich 4D sections
                    if ((isFullDocRequest || !data?.sections || data.sections.length <= 2) && (!isMinimal || !data?.sections || data.sections.length <= 2)) {
                        const synthesized = synthesizeComprehensiveDocument(prompt, effectiveDocTitle);
                        data = {
                            ...synthesized,
                            title: effectiveDocTitle || synthesized.title
                        };
                    }

                    // If request has activeArtifact that is markdown-document, and prompt is a section modification, surgically merge
                    if (request.activeArtifact?.type === 'markdown-document' && request.activeArtifact.data) {
                        const activeDoc = request.activeArtifact.data as MarkdownDocumentData;
                        const sectionMatch = prompt.match(/for section ["'](.*?)["']/i) || prompt.match(/selected excerpt: ["'](.*?)["']/i);
                        if (sectionMatch && activeDoc.sections && activeDoc.sections.length > 0) {
                            const targetQuery = sectionMatch[1].toLowerCase().trim();
                            const targetIdx = activeDoc.sections.findIndex(s => (s.content || s.calloutTitle || '').toLowerCase().includes(targetQuery));
                            if (targetIdx !== -1 && data?.sections && data.sections.length > 0) {
                                const mergedSections = [...activeDoc.sections];
                                mergedSections.splice(targetIdx, 1, ...data.sections);
                                data.sections = mergedSections;
                                data.title = activeDoc.title || effectiveDocTitle;
                                effectiveDocTitle = data.title;
                            }
                        }
                    }

                    // Sanitize and guarantee all headings and callouts are fully populated
                    if (data && Array.isArray(data.sections)) {
                        let headingCount = 0;
                        data.sections = data.sections.map((sec: any, idx: number) => {
                            if (!sec || typeof sec !== 'object') return sec;
                            const secType = sec.type || 'paragraph';
                            const id = sec.id || `sec-${secType}-${idx + 1}`;

                            if (secType === 'heading') {
                                const rawContent = sec.content ?? sec.heading ?? sec.title ?? sec.text ?? sec.name ?? sec.headingText ?? sec.value ?? '';
                                let content = typeof rawContent === 'string' ? rawContent.trim() : '';
                                const currentHeadingIdx = headingCount++;

                                if (!content || /^(heading(\s+text)?\.{0,3}|new\s+section(\s+heading)?\.{0,3}|untitled(\s+section)?\.{0,3})$/i.test(content)) {
                                    const num = currentHeadingIdx + 1;
                                    if (/1776/i.test(effectiveDocTitle)) {
                                        const fallback1776Headings = [
                                            '1. Executive Overview: The Genesis of Modern Republicanism',
                                            '2. Key Pillars & Chronology: From Grievances to Universal Truths',
                                            '2.1 The Enlightenment’s Crucible & Thomas Paine’s Catalyst',
                                            '2.2 The Declaration of Independence: Anatomy of a Revolution',
                                            '3. Strategic & Ideological Impact on Modern Governance'
                                        ];
                                        content = fallback1776Headings[currentHeadingIdx] || `${num}. Strategic Historical Analysis & Ideological Turning Points`;
                                    } else if (/auth|security|identity/i.test(effectiveDocTitle)) {
                                        const fallbackAuthHeadings = [
                                            '1. Executive Summary: Identity & Access Architecture',
                                            '2. Architectural Pillars & Protocol Chronology',
                                            '2.1 Protocol Specification: OAuth 2.1 & PKCE Handshake',
                                            '2.2 Token Lifecycle & Revocation Semantics',
                                            '3. Verification, Automated Guardrails & Compliance'
                                        ];
                                        content = fallbackAuthHeadings[currentHeadingIdx] || `${num}. Architectural Specification & Security Verification`;
                                    } else {
                                        const genericHeadings = [
                                            `1. Executive Summary: Strategic Blueprint for ${effectiveDocTitle}`,
                                            '2. Key Architectural Pillars & System Design',
                                            '2.1 Modular System Architecture & Data Flow',
                                            '2.2 Operational Reliability & Automated Guardrails',
                                            '3. Actionable Milestones & Convergence Checklist'
                                        ];
                                        content = genericHeadings[currentHeadingIdx] || `${num}. Implementation Details & Analysis`;
                                    }
                                }

                                return {
                                    ...sec,
                                    id,
                                    type: 'heading',
                                    level: sec.level === 1 || sec.level === 2 || sec.level === 3 ? sec.level : (currentHeadingIdx === 0 ? 1 : 2),
                                    content
                                };
                            } else if (secType === 'callout') {
                                let calloutTitle = sec.calloutTitle ?? sec.title ?? sec.heading ?? sec.name ?? '';
                                let content = sec.content ?? sec.text ?? sec.body ?? '';

                                if (!calloutTitle || /^(callout(\s+title)?\.{0,3}|note\.{0,3}|title\.{0,3})$/i.test(calloutTitle.trim())) {
                                    const boldPrefixMatch = content.match(/^\*\*([^*:]+?)(?:\s*Callout)?:\*\*\s*([\s\S]*)$/i) || content.match(/^\[!([A-Z]+)\]\s*(.*)$/i);
                                    if (boldPrefixMatch) {
                                        calloutTitle = boldPrefixMatch[1].trim();
                                        content = boldPrefixMatch[2].trim() || content;
                                    } else if (/1776/i.test(effectiveDocTitle)) {
                                        calloutTitle = 'Primary Source & Historical Context';
                                    } else if (/auth|security/i.test(effectiveDocTitle)) {
                                        calloutTitle = 'Security Guardrail & Cryptographic Protocol';
                                    } else {
                                        calloutTitle = 'Core Architecture Insight';
                                    }
                                }

                                return {
                                    ...sec,
                                    id,
                                    type: 'callout',
                                    calloutType: sec.calloutType || 'info',
                                    calloutTitle,
                                    content: content || calloutTitle
                                };
                            }
                            return sec;
                        });

                        const rawSub = data.subtitle || (data as any).docSubtitle || (data as any).description;
                        if (!rawSub || /^(click\s+to\s+add\s+document\s+subtitle|document\s+subtitle|subtitle)\.{0,3}$/i.test(rawSub.trim())) {
                            if (/1776/i.test(effectiveDocTitle)) {
                                data.subtitle = 'Examining the Birth of a Nation, Enlightenment Philosophy, and the Crucible of Liberty';
                            } else if (/auth|security|identity|zero[- ]trust/i.test(effectiveDocTitle)) {
                                data.subtitle = 'Comprehensive Architecture, Protocol Specifications, Token Lifecycle, and Security Guardrails';
                            } else {
                                data.subtitle = `Strategic overview, architectural pillars, and execution roadmap for ${effectiveDocTitle}`;
                            }
                        }
                        if (data.sections) {
                            data.sections = ensureCompleteSections(data.sections, effectiveDocTitle);
                            data.sections = enrichGroundedCitations(data.sections);
                        }
                    }

                    if (isMediaRequest && type === 'markdown-document') {
                        const kind = isVideoRequest ? 'video' : 'image';
                        const hasMediaSection = data?.sections?.some((s: any) => s.type === 'editorial-image' || s.type === 'image' || s.type === 'video');
                        if (!hasMediaSection) {
                            const mediaDoc = synthesizeMediaDocument(prompt, kind, effectiveDocTitle);
                            data = {
                                ...mediaDoc,
                                ...(data || {}),
                                sections: [
                                    ...mediaDoc.sections.filter(s => s.type === 'editorial-image' || s.type === 'image' || s.type === 'video'),
                                    ...(data?.sections || mediaDoc.sections.filter(s => s.type !== 'editorial-image' && s.type !== 'image' && s.type !== 'video'))
                                ]
                            };
                        }
                    }

                    parsed.title = effectiveDocTitle;
                }

                const isSameType = request.activeArtifact?.type === type;
                const effectiveVersion = (isSameType && request.activeArtifact) ? (request.activeArtifact.version || 1) + 1 : (parsed.version || 1);
                const effectiveId = (isSameType && request.activeArtifact) ? request.activeArtifact.id : (parsed.id || `art-${type}-${Date.now()}`);

                return {
                    id: effectiveId,
                    type: (type as PrimitiveType) || 'markdown-document',
                    title: parsed.title || 'Synthesized Canvas Artifact',
                    summary: parsed.summary || 'Generated with High Reasoning Engine.',
                    version: effectiveVersion,
                    createdAt: timestamp,
                    data: data || {}
                };
            }
        } catch {
            // If parsing failed, fallback below
        }
    }

    const lower = prompt.toLowerCase();
    const isImageRequest = /create\s+(?:a\s+)?picture|generate\s+(?:a\s+)?picture|picture\s+of|draw\s+(?:a\s+)?picture|image\s+of|generate\s+(?:an?\s+)?image|create\s+(?:an?\s+)?image|photo\s+of|photograph\s+of|illustration\s+of|painting\s+of|artwork\s+of|draw\s+(?:an?\s+)?image|make\s+(?:a\s+)?picture|make\s+(?:an?\s+)?image|\bpicture\b|\bphoto\b|\billustration\b|\bpainting\b/i.test(prompt);
    const isVideoRequest = /create\s+(?:a\s+)?video|generate\s+(?:a\s+)?video|video\s+of|make\s+(?:a\s+)?video|film\s+of|motion\s+clip|video\s+clip|record\s+(?:a\s+)?video|\bvideo\s+file\b|\bvideo\b/i.test(prompt);
    const isMediaRequest = isImageRequest || isVideoRequest;

    if (isMediaRequest) {
        const kind = isVideoRequest ? 'video' : 'image';
        const synthesizedDoc = synthesizeMediaDocument(prompt, kind);
        return {
            id: `art-doc-${Date.now()}`,
            type: 'markdown-document',
            title: synthesizedDoc.title,
            summary: kind === 'video'
                ? `Generated cinematic video document: "${synthesizedDoc.title}" on the visual canvas.`
                : `Generated editorial illustration and visual document: "${synthesizedDoc.title}" on the visual canvas.`,
            version: 1,
            createdAt: timestamp,
            data: synthesizedDoc
        };
    }

    // Check if query is 3D scene / 3D model / 3D plane / spatial scene
    const isSandboxOrAppRequest = !isMediaRequest && (
        /preview|sandbox|\bapp\b|web\s*app|landing\s*page|calculator|game|dashboard|component|widget|mockup|\bui\b|react|html|css|javascript|typescript|python|interactive|simulator|timeline/i.test(prompt) ||
        lower.includes('preview') || lower.includes('sandbox') || lower.includes('calculator') || lower.includes('landing page') ||
        lower.includes('web app') || lower.includes('react app') || lower.includes('dashboard') || lower.includes('widget') ||
        lower.includes('interactive') || lower.includes('simulator')
    );
    const isDocExplicitRequest = /document|doc\b|spec|write\s+(?:a\s+)?(?:doc|document|spec|essay|report|paper)|article|research\s+paper/i.test(prompt);

    const is3DActive = request.activeArtifact?.type === '3d-scene';
    const is3DFollowUp = !isMediaRequest && !isSandboxOrAppRequest && !isDocExplicitRequest && is3DActive && (
        /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff|speed|camera|view|scene|heading|pitch|thrust/i.test(prompt) ||
        lower.includes('animate') || lower.includes('fly') || lower.includes('play') || lower.includes('orbit') || lower.includes('takeoff')
    );
    const is3DSceneRequest = !isMediaRequest && !isSandboxOrAppRequest && !isDocExplicitRequest && (is3DFollowUp ||
        /3d\s+scene|3d\s+plane|3d\s+world|3d\s+model|spatial\s+scene|three\.js\s+scene|r3f\s+scene|airplane|aircraft|3d\s+flight|flight\s+corridor|3d\s+visual|god\s*rays?|light\s*shaft|contrails?|control\s*surfaces?|terrain\s*biomes?|atmospheric\s*scattering/i.test(prompt) ||
        ((lower.includes('3d') || lower.includes('spatial')) && (lower.includes('scene') || lower.includes('plane') || lower.includes('world') || lower.includes('model') || lower.includes('flight') || lower.includes('render') || lower.includes('environment'))));

    if (is3DSceneRequest) {
        const active3DData = is3DActive ? (request.activeArtifact?.data as Scene3DData) : undefined;
        const isExplicitFlight = /plane|airplane|jet\s+aircraft|jet\s+transit|flight\s+corridor|aviation\s+sim/i.test(prompt);
        const isAnimateOnly = is3DFollowUp && !/new|change|build|create|switch/i.test(prompt) && /animate|fly|flight|motion|orbit|play|simulation|bank|roll|spin|takeoff/i.test(prompt);

        const docContent = request.activeArtifact?.type === 'markdown-document'
            ? (request.activeArtifact.data as MarkdownDocumentData)?.sections?.map(s => s.content || s.calloutTitle || '').join(' ')
            : undefined;
        const contextualSynthesized = synthesizeContextual3DScene(prompt, {
            activeArtifact: request.activeArtifact,
            chatHistory: request.chatHistory,
            docTitle: request.activeArtifact?.title,
            docContent
        });

        const sceneTitle = (isAnimateOnly && active3DData) ? active3DData.title : (isExplicitFlight ? '3D Aircraft & Flight Corridor' : contextualSynthesized.title);
        const sceneSummary = isAnimateOnly && isExplicitFlight
            ? 'Animated 3D flight trajectory: dynamic bank, roll, and engine thrust active.'
            : (isExplicitFlight ? 'Interactive procedural 3D plane and spatial flight environment.' : (contextualSynthesized.subtitle || 'Interactive 3D spatial scene synthesized with Studio 3D Engine.'));

        const planeObjects = [
            {
                id: 'obj-aircraft-1',
                content: {
                    type: '3d-scene' as const,
                    durableUri: 'internal:plane',
                    mimeType: 'model/procedural-aircraft',
                    metadata: { dims: { width: 12, height: 4, depth: 14 } }
                },
                space: {
                    spatial3d: { x: 0, y: 3.5, z: 0, pitch: 0, yaw: 0, roll: 0 }
                },
                time: { startMs: 0, durationMs: 10000 },
                lineage: { version: 1 }
            }
        ];

        const defaultObjects = isExplicitFlight
            ? planeObjects
            : (contextualSynthesized.objects || []);

        const hasGodRays = /god\s*ray|crepuscular|light\s*shaft|volumetric\s*light|sunlight/i.test(prompt) || !!active3DData?.features?.godRays;
        const hasAtmosphere = /atmosphere|scattering|rayleigh|mie|realistic\s*sky|sunlight/i.test(prompt) || !!active3DData?.features?.atmosphericScattering;
        const hasContrails = /contrail|vapor|vortex|wingtip\s*trail/i.test(prompt) || !!active3DData?.features?.contrails;
        const hasControlSurfaces = /control\s*surface|aileron|elevator|rudder|flap/i.test(prompt) || !!active3DData?.features?.controlSurfaces;
        const hasTerrainBiomes = /biome|terrain|canyon|alpine|mountain|coastal|desert/i.test(prompt) || !!active3DData?.features?.terrainBiomes;

        const fallbackFeatures = {
            ...(contextualSynthesized.features || {}),
            ...(active3DData?.features || {}),
            ...(hasGodRays ? { godRays: true } : {}),
            ...(hasAtmosphere ? { atmosphericScattering: true } : {}),
            ...(hasContrails ? { contrails: true } : {}),
            ...(hasControlSurfaces ? { controlSurfaces: true } : {}),
            ...(hasTerrainBiomes ? { terrainBiomes: (active3DData?.features?.terrainBiomes || { biomeType: 'alpine' as const }) } : {})
        };

        const fallback3DData: Scene3DData = {
            title: active3DData?.title || sceneTitle,
            subtitle: (isAnimateOnly && active3DData?.subtitle) ? active3DData.subtitle : (active3DData?.subtitle || sceneSummary),
            worldBranch: active3DData?.worldBranch || contextualSynthesized.worldBranch,
            sceneType: active3DData?.sceneType || contextualSynthesized.sceneType,
            renderMode: active3DData?.renderMode || contextualSynthesized.renderMode || 'pbr',
            cameraMode: lower.includes('fps') ? 'fps' : (lower.includes('orbit') ? 'orbit' : (active3DData?.cameraMode || contextualSynthesized.cameraMode || 'orbit')),
            animation: isAnimateOnly ? (lower.includes('orbit') ? 'orbit' : 'flight') : (active3DData?.animation || contextualSynthesized.animation),
            timeline: isAnimateOnly ? {
                currentTimeMs: active3DData?.timeline?.currentTimeMs ?? 0,
                durationMs: active3DData?.timeline?.durationMs ?? 10000,
                isPlaying: true,
                speed: active3DData?.timeline?.speed ?? 1.0,
                playbackSpeed: active3DData?.timeline?.playbackSpeed ?? 1.0,
                isLooping: true,
                ...(active3DData?.timeline || {})
            } : (active3DData?.timeline || contextualSynthesized.timeline),
            camera: active3DData?.camera || contextualSynthesized.camera || {
                position: [15, 12, 20],
                target: [0, 2, 0],
                fov: 45
            },
            environment: {
                lighting: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 'twilight' : (active3DData?.environment?.lighting || 'daylight'),
                lightingPreset: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 'twilight' : (active3DData?.environment?.lightingPreset || active3DData?.environment?.lighting || 'daylight'),
                ambientIntensity: (lower.includes('dimmer') || lower.includes('dim') || lower.includes('darker')) ? 0.3 : (active3DData?.environment?.ambientIntensity),
                ground: true,
                ...(active3DData?.environment || {}),
                ...(contextualSynthesized.environment || {}),
                skybox: (hasAtmosphere || hasGodRays || isExplicitFlight || !!fallbackFeatures.godRays || !!fallbackFeatures.atmosphericScattering || !!fallbackFeatures.contrails) ? 'realistic-sky' : (active3DData?.environment?.skybox || contextualSynthesized.environment?.skybox || 'cyberpunk')
            },
            geoAnchor: active3DData?.geoAnchor || contextualSynthesized.geoAnchor || {
                lat: 37.7900,
                lng: -122.4000,
                elevation: 15.2,
                active: true,
                landmarkName: isExplicitFlight ? 'Flight Corridor' : 'San Francisco Bay Airspace'
            },
            objects: active3DData?.objects || defaultObjects,
            customScript: active3DData?.customScript || active3DData?.code || contextualSynthesized.customScript,
            code: active3DData?.code || active3DData?.customScript || contextualSynthesized.code,
            shaders: active3DData?.shaders,
            features: fallbackFeatures,
            customMeshes: (() => {
                const base = active3DData?.customMeshes ? [...active3DData.customMeshes] : (contextualSynthesized.customMeshes ? [...contextualSynthesized.customMeshes] : []);
                if (lower.includes('add') && (lower.includes('building') || lower.includes('tower') || lower.includes('structure') || lower.includes('box') || lower.includes('mesh') || lower.includes('sphere') || lower.includes('cylinder'))) {
                    const meshType = lower.includes('sphere') ? 'sphere' : lower.includes('cylinder') ? 'cylinder' : 'box';
                    const newMeshId = `mesh-added-${Date.now()}`;
                    const refMesh = base[base.length - 1];
                    const newPos: [number, number, number] = refMesh?.position ? [refMesh.position[0] + 8, refMesh.position[1], refMesh.position[2]] : [8, 4, 0];
                    base.push({
                        id: newMeshId,
                        name: lower.includes('building') ? 'Adjacent Tower' : 'Added Geometry',
                        type: meshType as CustomMesh['type'],
                        position: newPos,
                        rotation: [0, 0, 0],
                        scale: refMesh?.scale ? [...refMesh.scale] : [4, 8, 4],
                        material: { color: 0x10b981, roughness: 0.4, metalness: 0.3 }
                    });
                }
                return base;
            })(),
            operatorStack: active3DData?.operatorStack || [],
            actionLog: active3DData?.actionLog || [],
            sculptSettings: active3DData?.sculptSettings,
            selectedMeshId: active3DData?.selectedMeshId
        };

        return {
            id: (is3DActive ? request.activeArtifact?.id : undefined) || `art-3d-${Date.now()}`,
            type: '3d-scene',
            title: fallback3DData.title,
            summary: sceneSummary,
            version: is3DActive ? (request.activeArtifact?.version || 1) + 1 : 1,
            createdAt: timestamp,
            data: fallback3DData
        };
    }

    // Check if query is flow/graph
    if (lower.includes('flow') || lower.includes('graph') || lower.includes('pipeline')) {
        return {
            id: `art-graph-${Date.now()}`,
            type: 'node-graph',
            title: 'System Architecture & Reasoning Pipeline',
            summary: 'Interactive node flow graph synthesized with Studio AI Engine.',
            version: 1,
            createdAt: timestamp,
            data: {
                title: 'System Architecture & Reasoning Pipeline',
                subtitle: 'Visual node graph mapping prompt inputs, superpowers, and live MCP pipes',
                nodes: [
                    { id: 'n1', label: 'Prompt Composer', subtitle: 'User Input & Context', category: 'input', color: 'blue', x: 80, y: 160, status: 'completed' },
                    { id: 'n2', label: 'Studio AI Engine', subtitle: 'High Reasoning active', category: 'ai', color: 'purple', x: 460, y: 80, status: 'active' },
                    { id: 'n3', label: 'MCP Live Integrations', subtitle: 'Stripe & GitHub Tools', category: 'process', color: 'indigo', x: 460, y: 260, status: 'active' },
                    { id: 'n4', label: 'Liquid Glass Canvas', subtitle: 'Rendered Visual Primitive', category: 'output', color: 'emerald', x: 840, y: 160, status: 'active' }
                ],
                edges: [
                    { id: 'e1', source: 'n1', target: 'n2', label: 'Feeds prompt', style: 'solid', color: 'purple' },
                    { id: 'e2', source: 'n1', target: 'n3', label: 'Triggers tools', style: 'dashed', color: 'indigo' },
                    { id: 'e3', source: 'n2', target: 'n4', label: 'Synthesizes stage', style: 'solid', color: 'emerald' },
                    { id: 'e4', source: 'n3', target: 'n4', label: 'Hydrates data', style: 'solid', color: 'emerald' }
                ]
            }
        };
    }

    // Check if query is sandbox / live preview / interactive web app OR cleanContent contains runnable code blocks
    const isSandboxExplicit = isSandboxOrAppRequest || /preview|sandbox|app|web\s*app|landing\s*page|calculator|game|dashboard|component|widget|mockup|ui|react|html|css|javascript|typescript|python|interactive|simulator|timeline/i.test(prompt);

    const extractedSandbox = extractCodeSandboxArtifact(prompt, cleanContent, request.activeArtifact);
    if (extractedSandbox && (isSandboxExplicit || extractedSandbox.hasRunnableCode)) {
        return extractedSandbox.artifact;
    }

    // Default: rich Markdown Document artifact wrapping model text
    const newSections = markdownStringToSections(cleanContent);
    
    let finalTitle = extractDocumentTitle(prompt, request.activeArtifact?.title || 'Strategic Specification & Notes');
    let finalSections = newSections;

    if (request.activeArtifact?.type === 'markdown-document' && request.activeArtifact.data) {
        const activeDoc = request.activeArtifact.data as MarkdownDocumentData;
        finalTitle = activeDoc.title && activeDoc.title !== 'Markdown Document' ? activeDoc.title : finalTitle;
        const sectionMatch = prompt.match(/for section ["'](.*?)["']/i) || prompt.match(/selected excerpt: ["'](.*?)["']/i);
        if (sectionMatch && activeDoc.sections && activeDoc.sections.length > 0) {
            const targetQuery = sectionMatch[1].toLowerCase().trim();
            const targetIdx = activeDoc.sections.findIndex(s => (s.content || s.calloutTitle || '').toLowerCase().includes(targetQuery));
            if (targetIdx !== -1) {
                const merged = [...activeDoc.sections];
                merged.splice(targetIdx, 1, ...newSections);
                finalSections = merged;
            }
        }
    } else if (newSections[0]?.type === 'heading' && newSections[0].content) {
        finalTitle = newSections[0].content;
    }

    const isDocRequest = lower.includes('write') || lower.includes('document') || lower.includes('spec') || lower.includes('proposal') || lower.includes('1776') || lower.includes('guide') || lower.includes('report') || lower.includes('auth') || lower.includes('paper') || lower.includes('research') || lower.includes('essay') || lower.includes('article') || lower.includes('lexington') || lower.includes('battle');

    let docData: MarkdownDocumentData;
    if (isDocRequest || lower.includes('1776') || finalSections.length <= 1) {
        docData = synthesizeComprehensiveDocument(prompt, finalTitle);
    } else if (newSections.length > 2) {
        docData = {
            title: finalTitle,
            subtitle: `Synthesized with Studio AI & ${request.attachedSkills?.map(s => s.name).join(', ') || 'Superpowers'}`,
            author: DEFAULT_DOCUMENT_AUTHOR,
            lastUpdated: 'Just now',
            tags: ['Reasoning', 'CupertinoDesign', 'Artifacts', 'Specification'],
            sections: finalSections
        };
    } else {
        docData = synthesizeComprehensiveDocument(prompt, finalTitle);
    }

    if (docData && docData.sections) {
        docData.sections = ensureCompleteSections(docData.sections, finalTitle);
        docData.sections = enrichGroundedCitations(docData.sections);
    }

    return {
        id: request.activeArtifact?.id || `art-doc-${Date.now()}`,
        type: 'markdown-document',
        title: docData.title,
        summary: 'Executive brief synthesized with High Reasoning Engine.',
        version: (request.activeArtifact?.version || 0) + 1,
        createdAt: timestamp,
        data: docData
    };
}
