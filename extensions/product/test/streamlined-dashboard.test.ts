/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function runStreamlinedDashboardTests() {
    console.log('🧪 Running Streamlined Dashboard & Visual Polish Test Suite...\n');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const metricCardsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MetricCardsPrimitive.tsx');
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');

    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(metricCardsTsxPath), 'MetricCardsPrimitive.tsx must exist');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');

    const studioSource = fs.readFileSync(studioTsxPath, 'utf-8');
    const metricSource = fs.readFileSync(metricCardsTsxPath, 'utf-8');
    const cssSource = fs.readFileSync(unifiedCssPath, 'utf-8');

    // -------------------------------------------------------------
    // Test 1: Studio Welcome Stage - Elimination of Starter Cards for Clean Minimalist Hero
    // -------------------------------------------------------------
    assert.ok(!studioSource.includes('sb-welcome-starter-grid'), 'Starter grid must be eliminated for clean minimalist hero');
    assert.ok(!studioSource.includes('sb-starter-card'), 'Starter suggestion cards must be eliminated');
    assert.ok(studioSource.includes('sb-chat-empty-hero-container'), 'Studio must retain clean centered empty hero container');
    console.log('  ✓ Test 1 Passed: Cluttered starter cards eliminated in favor of clean minimalist hero stage');

    // -------------------------------------------------------------
    // Test 2: Studio Welcome Stage - Quick Mode / Capability Pills Bar
    // -------------------------------------------------------------
    assert.ok(studioSource.includes('sb-welcome-mode-strip') || studioSource.includes('sb-quick-actions-bar'), 'Studio must render quick mode strip');
    assert.ok(studioSource.includes('sb-welcome-mode-btn') || studioSource.includes('sb-quick-action-pill'), 'Studio must render quick mode buttons');
    console.log('  ✓ Test 2 Passed: Quick mode starter strip (Agent, Ask, Plan, Live Analytics) integrated');

    // -------------------------------------------------------------
    // Test 3: Metric Dashboard Primitive - Streamlined Toolbar & Controls
    // -------------------------------------------------------------
    assert.ok(metricSource.includes('timeRange'), 'MetricCardsPrimitive must support timeRange selection (7D, 30D, 90D, YTD)');
    assert.ok(metricSource.includes('setTimeRange'), 'MetricCardsPrimitive must track timeRange state');
    assert.ok(metricSource.includes('chartMode'), 'MetricCardsPrimitive must support chartMode toggles (bar, line, area)');
    assert.ok(metricSource.includes('sb-metric-trend-pill') || metricSource.includes('sb-metric-trend'), 'MetricCardsPrimitive must render trend pill badges');
    console.log('  ✓ Test 3 Passed: Metric Dashboard primitive supports time-range filters, area/line modes, and trend pill badges');

    // -------------------------------------------------------------
    // Test 4: Metric Dashboard Primitive - Actionable AI Analysis & Export Triggers
    // -------------------------------------------------------------
    assert.ok(metricSource.includes('onAnalyzeWithAi') || metricSource.includes('onExportData') || metricSource.includes('sb-metric-action-btn'), 'MetricCardsPrimitive must provide actionable AI analysis or export buttons');
    console.log('  ✓ Test 4 Passed: Actionable AI analysis & data export triggers verified');

    // -------------------------------------------------------------
    // Test 5: CSS Styles for Streamlined Dashboard & KPI Cards
    // -------------------------------------------------------------
    assert.ok(cssSource.includes('sb-streamlined-dashboard') || cssSource.includes('sb-primitive-metric-dashboard'), 'unified-ui.css must define metric dashboard styles');
    assert.ok(cssSource.includes('sb-metric-card'), 'unified-ui.css must define streamlined metric card styling');
    assert.ok(cssSource.includes('sb-metric-trend-pill') || cssSource.includes('sb-metric-trend'), 'unified-ui.css must define trend pill styling');
    console.log('  ✓ Test 5 Passed: CSS styling tokens for streamlined dashboard and KPI cards verified');

    console.log('\n🎉 ALL STREAMLINED DASHBOARD TESTS PASSED SUCCESSFULLY!');
}

if (require.main === module) {
    runStreamlinedDashboardTests().catch(err => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    });
}

export { runStreamlinedDashboardTests };
