import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runUnifiedStylingAuditTests() {
    console.log('🧪 Running Unified Styling & Button Audit Test Suite...');

    const styleDir = path.resolve(__dirname, '../src/browser/style');
    const unifiedCssPath = path.join(styleDir, 'unified-ui.css');
    const indexCssPath = path.join(styleDir, 'index.css');

    // Test 1: Unified UI CSS file exists
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist in src/browser/style/');
    const unifiedCss = fs.readFileSync(unifiedCssPath, 'utf-8');
    const indexCss = fs.readFileSync(indexCssPath, 'utf-8');
    console.log('  ✓ Test 1 Passed: unified-ui.css exists in src/browser/style/');

    // Test 2: index.css imports or incorporates unified-ui.css
    assert.ok(
        indexCss.includes('@import "./unified-ui.css"') ||
        indexCss.includes('@import \'./unified-ui.css\'') ||
        indexCss.includes('@import "unified-ui.css"') ||
        indexCss.includes('@import \'unified-ui.css\''),
        'index.css must import unified-ui.css at the top of the stylesheet'
    );
    console.log('  ✓ Test 2 Passed: index.css imports unified-ui.css');

    // Test 3: Core Button System Tokens & Variants
    const requiredButtonClasses = [
        '.sb-btn',
        '.sb-btn-primary',
        '.sb-btn-secondary',
        '.sb-btn-ghost',
        '.sb-btn-danger',
        '.sb-btn-accent',
        '.sb-btn-xs',
        '.sb-btn-sm',
        '.sb-btn-md',
        '.sb-btn-lg',
        '.sb-icon-button',
        '.sb-segment-btn',
        '.sb-floating-pill'
    ];

    for (const cls of requiredButtonClasses) {
        assert.ok(
            unifiedCss.includes(cls),
            `unified-ui.css must define standard button class "${cls}"`
        );
    }
    console.log('  ✓ Test 3 Passed: All core button classes & sizing tokens are codified in unified-ui.css');

    // Test 4: Interactive Micro-Interactions & Spring Physics
    const interactiveFeatures = [
        ':focus-visible',
        ':disabled',
        ':hover',
        ':active',
        'scale(0.97)',
        'cubic-bezier',
        'backdrop-filter'
    ];

    for (const feat of interactiveFeatures) {
        assert.ok(
            unifiedCss.includes(feat),
            `unified-ui.css must include interactive feature "${feat}" for Apple-grade micro-interactions`
        );
    }
    console.log('  ✓ Test 4 Passed: Micro-interactions (focus-visible rings, spring active scales, disabled states) verified');

    // Test 5: Unified Interface Containers & Surfaces
    const requiredInterfaceClasses = [
        '.sb-surface-card-unified',
        '.sb-glass-card',
        '.sb-modal-unified',
        '.sb-input-unified',
        '.sb-badge-unified',
        '.sb-chip-unified',
        '.sb-popover-unified',
        '.sb-table-unified'
    ];

    for (const ifCls of requiredInterfaceClasses) {
        assert.ok(
            unifiedCss.includes(ifCls),
            `unified-ui.css must define interface container class "${ifCls}"`
        );
    }
    console.log('  ✓ Test 5 Passed: Unified interface containers (cards, modals, inputs, badges, popovers, tables) defined');

    // Test 6: Audit all TSX components for Button class harmonization
    const browserSrcDir = path.resolve(__dirname, '../src/browser');
    
    function getAllTsxFiles(dir: string): string[] {
        const files: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...getAllTsxFiles(fullPath));
            } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) {
                files.push(fullPath);
            }
        }
        return files;
    }

    const tsxFiles = getAllTsxFiles(browserSrcDir);
    assert.ok(tsxFiles.length > 5, 'Should discover TSX components in browser src');

    let totalButtonsFound = 0;

    /**
     * Extracts the attribute text of every `<button ...>` opening tag. A brace-aware scan is
     * required because attribute expressions routinely contain `>` (e.g. `onClick={() => ...}`),
     * which a naive `[^>]*` regex would stop at before reaching `className`.
     */
    function extractButtonAttributes(source: string): string[] {
        const results: string[] = [];
        const tagRegex = /<button\b/g;
        let match: RegExpExecArray | null;
        while ((match = tagRegex.exec(source)) !== null) {
            let i = match.index + match[0].length;
            let depth = 0;
            let quote: string | null = null;
            while (i < source.length) {
                const ch = source[i];
                if (quote) {
                    if (ch === '\\') { i += 2; continue; }
                    if (ch === quote) quote = null;
                } else if (ch === '"' || ch === "'" || ch === '`') {
                    quote = ch;
                } else if (ch === '{') {
                    depth++;
                } else if (ch === '}') {
                    depth--;
                } else if (ch === '>' && depth === 0) {
                    break;
                }
                i++;
            }
            results.push(source.slice(match.index + match[0].length, i));
            tagRegex.lastIndex = i;
        }
        return results;
    }

    for (const filePath of tsxFiles) {
        // Ignore embedded source templates (e.g. Live Code starter apps) — they are user-facing
        // sample code, not Scratchbox UI, so their buttons are not subject to the design system.
        // Likewise ignore `<button` text that only appears inside line comments or regex literals
        // (e.g. ChatMarkdownRenderer's parser for model-emitted `<button>` pills, added in 5f8e5b4):
        // those are not rendered button elements.
        const content = fs.readFileSync(filePath, 'utf-8')
            .replace(/`(?:\\[\s\S]|[^`\\])*`/g, literal => literal.includes('<button') ? '``' : literal)
            .replace(/^[ \t]*\/\/.*$/gm, line => line.includes('<button') ? '' : line)
            .replace(/\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])*<button(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])*\/[dgimsuy]*/g, '/(?:)/');
        // Module-level string constants (e.g. `const CHIP = 'sb-cam-chip'`) used inside className
        // templates resolve to their literal, so a class held in a constant is audited, not missed.
        const stringConstants = new Map<string, string>();
        for (const m of content.matchAll(/^const ([A-Z_][A-Z0-9_]*)\s*=\s*['"]([^'"]*)['"];/gm)) {
            stringConstants.set(m[1], m[2]);
        }
        for (const buttonAttributes of extractButtonAttributes(content)) {
            totalButtonsFound++;
            
            // Extract className value whether static string or template literal
            let classString = '';
            const staticMatch = /className=["']([^"']+)["']/.exec(buttonAttributes);
            const templateMatch = /className=\{`([^`]+)`\}/.exec(buttonAttributes);
            const jsxMatch = /className=\{([^}]+)\}/.exec(buttonAttributes);

            if (staticMatch) {
                classString = staticMatch[1];
            } else if (templateMatch) {
                classString = templateMatch[1];
            } else if (jsxMatch) {
                // A JSX expression (`a ?? 'sb-x …'`, `cond ? 'sb-y' : 'sb-z'`): read the class names inside its string literals.
                classString = jsxMatch[1].replace(/['"]/g, ' ');
            }
            
            // Extract all static tokens from classString (ignoring ${...} expressions)
            const cleanedTokens = classString
                .replace(/\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}/g, (whole, name: string) => stringConstants.get(name) ?? whole)
                .replace(/\$\{[^}]+\}/g, ' ').trim().split(/\s+/).filter(Boolean);
            
            // All buttons should have a recognized button class name starting with sb-
            // The design-system rule: every button carries at least one `sb-*` class.
            const hasRecognizedClass = cleanedTokens.some(c => c.startsWith('sb-'));
            assert.ok(
                hasRecognizedClass,
                `Button in ${path.basename(filePath)} has untracked styling class: "${classString}" in tag: <button ${buttonAttributes}>`
            );
        }
    }

    assert.ok(totalButtonsFound >= 300, `Expected at least 300 audited buttons across the application, but found ${totalButtonsFound}`);
    console.log(`  ✓ Test 6 Passed: Full code audit verified exactly ${totalButtonsFound} buttons across ${tsxFiles.length} source components`);

    // Test 7: Minimalist Neutral Color Palette Verification
    assert.ok(
        unifiedCss.includes('--sb-btn-primary-bg: #ffffff') || unifiedCss.includes('--sb-btn-primary-bg: #f8fafc'),
        'Primary button background in unified-ui.css should use minimalist high-contrast white'
    );
    assert.ok(
        unifiedCss.includes('--sb-btn-primary-text: #000000') || unifiedCss.includes('--sb-btn-primary-text: #0d0d0d') || unifiedCss.includes('--sb-btn-primary-text: #0f172a'),
        'Primary button text in unified-ui.css should use dark text on white'
    );
    assert.ok(
        indexCss.includes('#212121') || indexCss.includes('#171717'),
        'index.css should define dark graphite surface colors (#212121 or #171717)'
    );
    console.log('  ✓ Test 7 Passed: Minimalist neutral color palette & high-contrast button styling verified');

    // Test 8: Scratchbox.ai (www.scratchbox.ai) Brand Colors & Font Styling
    assert.ok(
        indexCss.includes('SF Pro Display') && indexCss.includes('Geist') && indexCss.includes('Inter'),
        'index.css must include modern Scratchbox.ai typographic font stack (SF Pro, Inter, Geist)'
    );
    assert.ok(
        indexCss.includes('SF Mono') && indexCss.includes('Geist Mono'),
        'index.css must include Scratchbox.ai monospace font stack (SF Mono, Geist Mono)'
    );
    assert.ok(
        indexCss.includes('--sb-brand-blue:') || indexCss.includes('--sb-system-blue: #3b82f6') || indexCss.includes('--sb-system-blue: #2563eb'),
        'index.css must declare Scratchbox.ai electric blue brand color'
    );
    console.log('  ✓ Test 8 Passed: www.scratchbox.ai brand color (#3b82f6) and font styling (SF Pro/Inter/Geist) verified');

    // Test 9: Workspace & Sidebar Text Contrast Safety
    assert.ok(
        unifiedCss.includes('.sb-workspace-name {') && unifiedCss.includes('color: var(--sb-text-label);'),
        '.sb-workspace-name must use var(--sb-text-label) for light/dark theme contrast safety'
    );
    assert.ok(
        unifiedCss.includes('.sb-workspace-thread-item {') && unifiedCss.includes('color: var(--sb-text-secondary);'),
        '.sb-workspace-thread-item must use var(--sb-text-secondary) for light/dark theme contrast safety'
    );
    assert.ok(
        unifiedCss.includes('body.sb-light .sb-workspace-thread-selected {'),
        'unified-ui.css must provide light theme override for selected workspace threads'
    );
    console.log('  ✓ Test 9 Passed: Workspace & sidebar text contrast safety across light & dark themes verified');

    console.log('\n🎉 ALL UNIFIED STYLING & BUTTON AUDIT TESTS PASSED SUCCESSFULLY!');
}

test('unified-styling-audit.test', async () => {
    await runUnifiedStylingAuditTests();
}, 180_000);
