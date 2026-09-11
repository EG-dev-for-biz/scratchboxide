/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Plan settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const PlanTab: React.FC = () => {
    const { monthlySpendLimit, planUpgradeNotice, setMonthlySpendLimit, setPlanUpgradeNotice, setSpendLimitSaved, spendLimitSaved } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <div className="flex items-center justify-between mb-1">
                <h2 className="sb-cursor-content-title">Plan &amp; Usage</h2>
                <span className="sb-badge-unified sb-badge-emerald font-semibold text-[11px] px-2.5 py-1">
                    ● 100% Free · Limited Time Promo
                </span>
            </div>

            {/* Dual Plan Cards */}
            <div className="grid grid-cols-2 gap-4">
                <div className="sb-cursor-plan-card sb-plan-active-promo-card">
                    <div className="flex items-center justify-between mb-1">
                        <span className="sb-plan-card-tag text-emerald-400 font-semibold">CURRENT PLAN · LIMITED TIME PROMO</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">
                            Free Active
                        </span>
                    </div>
                    <div className="sb-plan-price-title flex items-baseline gap-2">
                        <span>Pro</span>
                        <span className="text-sm font-bold text-emerald-400">$0/mo</span>
                        <span className="text-xs font-normal text-zinc-500 line-through">$20/mo</span>
                    </div>
                    <div className="sb-plan-desc">
                        Enjoy complimentary full Pro features during our limited-time launch promotion.
                    </div>
                    <button
                        type="button"
                        className="sb-cursor-row-btn mt-3 text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20"
                        onClick={() => {
                            setPlanUpgradeNotice('Your Pro plan is active and complimentary.');
                            setTimeout(() => setPlanUpgradeNotice(null), 3000);
                        }}
                    >
                        <span>✓ Active (Complimentary)</span>
                    </button>
                </div>

                <div className="sb-cursor-plan-card sb-plan-upgrade-card">
                    <div className="flex items-center justify-between mb-1">
                        <span className="sb-plan-card-tag text-blue-400">UPGRADE AVAILABLE</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-bold border border-blue-500/20">
                            Included
                        </span>
                    </div>
                    <div className="sb-plan-price-title flex items-baseline gap-2">
                        <span>Pro+</span>
                        <span className="text-sm font-bold text-blue-400">$0/mo</span>
                        <span className="text-xs font-normal text-zinc-500 line-through">$60/mo</span>
                    </div>
                    <div className="sb-plan-desc">
                        Unlock 3x more usage on Agent &amp; high-reasoning models — all free during preview.
                    </div>
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm mt-3"
                        onClick={() => {
                            setPlanUpgradeNotice('✓ Pro+ features and extended limits unlocked.');
                            setTimeout(() => setPlanUpgradeNotice(null), 3500);
                        }}
                    >
                        Upgrade (Free Promo)
                    </button>
                </div>
            </div>

            {planUpgradeNotice && (
                <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-800/40 text-xs text-emerald-300 font-medium animate-fadeIn">
                    {planUpgradeNotice}
                </div>
            )}

            {/* Included in Pro */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Included in Pro</div>
                <div className="sb-cursor-group-card p-4 space-y-4">
                    <div className="sb-usage-group-row">
                        <div className="flex justify-between items-center text-xs mb-1.5">
                            <span className="sb-usage-metric-title font-medium text-zinc-200">Google Reasoning Models</span>
                            <span className="sb-usage-metric-percent text-emerald-400 font-mono font-semibold">0% used · Unlimited Free</span>
                        </div>
                        <div className="text-[11px] text-zinc-500 mb-2">High-reasoning Gemini models and autonomous subagents</div>
                        <div className="sb-cursor-usage-bar">
                            <div className="sb-usage-fill" style={{ width: '0%' }} />
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1.5">Unlimited complimentary usage active during the promotional period.</div>
                    </div>

                    <div className="pt-3 border-t border-zinc-800/80 sb-usage-group-row">
                        <div className="flex justify-between items-center text-xs mb-1.5">
                            <span className="sb-usage-metric-title font-medium text-zinc-200">Background Agent Sessions</span>
                            <span className="sb-usage-metric-percent text-emerald-400 font-mono font-semibold">0% used · Unlimited Free</span>
                        </div>
                        <div className="text-[11px] text-zinc-500 mb-2">Multi-step TDD verification and autonomous tool pipelines</div>
                        <div className="sb-cursor-usage-bar">
                            <div className="sb-usage-fill" style={{ width: '0%' }} />
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1.5">All background agent sessions are 100% free during the promotion.</div>
                    </div>
                </div>
            </div>

            {/* On-Demand Usage */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">On-Demand Usage</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">On-Demand</div>
                            <div className="sb-cursor-row-desc">Usage past limits is free of charge during the promotion.</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-zinc-500 line-through">$43.93</span>
                            <span className="font-mono text-xs text-emerald-400 font-bold">$0.00 (Free Promo)</span>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Monthly Limit</div>
                            <div className="sb-cursor-row-desc">Complimentary unlimited usage active.</div>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                className="sb-cursor-select-dropdown"
                                value={monthlySpendLimit}
                                onChange={e => setMonthlySpendLimit(e.target.value)}
                            >
                                <option value="unlimited">Unlimited (Free Promo) ▾</option>
                                <option value="50">$50 / mo</option>
                                <option value="100">$100 / mo</option>
                                <option value="200">$200 / mo</option>
                            </select>
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={() => {
                                    setSpendLimitSaved(true);
                                    setTimeout(() => setSpendLimitSaved(false), 2500);
                                }}
                            >
                                {spendLimitSaved ? '✓ Saved' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
