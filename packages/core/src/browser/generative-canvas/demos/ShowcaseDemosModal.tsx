/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { PRELOADED_SHOWCASE_DEMOS, ShowcaseDemoItem } from './preloadedDemos';
import { IconClose, IconSearch, IconSparkles } from '../canvas-icons';

export interface ShowcaseDemosModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLaunchDemo: (demo: ShowcaseDemoItem) => void;
}

const CATEGORY_TABS = [
    { id: 'all', label: 'All Demos' },
    { id: '3d', label: '3D & Geospatial' },
    { id: 'video', label: 'VFX & Video NLE' },
    { id: 'graph', label: 'AI & Node Flow' },
    { id: 'sandbox', label: 'Live Sandbox' },
    { id: 'dashboard', label: 'Cockpit & Metrics' }
] as const;

export const ShowcaseDemosModal: React.FC<ShowcaseDemosModalProps> = ({
    isOpen,
    onClose,
    onLaunchDemo
}) => {
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedCategory, setSelectedCategory] = React.useState<string>('all');
    const searchInputRef = React.useRef<HTMLInputElement>(null);

    // Close on Escape key
    React.useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    // Focus input when opened
    React.useEffect(() => {
        if (isOpen) {
            setTimeout(() => {
                searchInputRef.current?.focus();
            }, 50);
        } else {
            setSearchQuery('');
            setSelectedCategory('all');
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const filteredDemos = PRELOADED_SHOWCASE_DEMOS.filter(demo => {
        const matchesCategory = selectedCategory === 'all' || demo.category === selectedCategory;
        if (!matchesCategory) return false;

        if (!searchQuery.trim()) return true;

        const query = searchQuery.toLowerCase().trim();
        const matchesTitle = demo.title.toLowerCase().includes(query);
        const matchesSub = demo.subtitle.toLowerCase().includes(query);
        const matchesDesc = demo.description.toLowerCase().includes(query);
        const matchesTags = demo.tags.some(tag => tag.toLowerCase().includes(query));

        return matchesTitle || matchesSub || matchesDesc || matchesTags;
    });

    return (
        <div className="sb-demos-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="sb-demos-modal-title">
            <div className="sb-demos-modal" onClick={e => e.stopPropagation()}>
                {/* Modal Header */}
                <div className="sb-demos-header">
                    <div className="sb-demos-header-left">
                        <div className="sb-demos-header-icon">
                            <IconSparkles size={18} />
                        </div>
                        <div>
                            <h2 id="sb-demos-modal-title" className="sb-demos-title">
                                Scratchbox Studio Showcase Demos
                            </h2>
                            <p className="sb-demos-subtitle">
                                Preloaded interactive environments, neural video pipelines, and live-code sandboxes ready to inspect and test.
                            </p>
                        </div>
                    </div>
                    <button
                        className="sb-demos-close-btn"
                        onClick={onClose}
                        title="Close (Esc)"
                        aria-label="Close"
                    >
                        <IconClose size={16} />
                    </button>
                </div>

                {/* Search & Filter Bar */}
                <div className="sb-demos-filters">
                    <div className="sb-demos-search-wrapper">
                        <IconSearch size={15} className="sb-demos-search-icon" />
                        <input
                            ref={searchInputRef}
                            type="text"
                            className="sb-demos-search-input"
                            placeholder="Filter demos by capability, engine, or keywords..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button
                                className="sb-demos-search-clear"
                                onClick={() => setSearchQuery('')}
                                title="Clear search"
                            >
                                <IconClose size={12} />
                            </button>
                        )}
                    </div>

                    <div className="sb-demos-category-pills">
                        {CATEGORY_TABS.map(tab => (
                            <button
                                key={tab.id}
                                className={`sb-demos-pill ${selectedCategory === tab.id ? 'active' : ''}`}
                                onClick={() => setSelectedCategory(tab.id)}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Demos Cards Grid */}
                <div className="sb-demos-grid-container">
                    {filteredDemos.length === 0 ? (
                        <div className="sb-demos-empty-state">
                            <p>No showcase demos found matching "{searchQuery}".</p>
                            <button
                                className="sb-demos-reset-btn"
                                onClick={() => {
                                    setSearchQuery('');
                                    setSelectedCategory('all');
                                }}
                            >
                                Reset Filters
                            </button>
                        </div>
                    ) : (
                        <div className="sb-demos-grid">
                            {filteredDemos.map(demo => (
                                <div key={demo.id} className="sb-demos-card" data-demo-id={demo.id}>
                                    <div className="sb-demos-card-header">
                                        <div className="sb-demos-badges">
                                            <span className="sb-demos-category-tag">{demo.categoryLabel}</span>
                                            {demo.highlightBadge && (
                                                <span className="sb-demos-highlight-badge">{demo.highlightBadge}</span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="sb-demos-card-body">
                                        <h3 className="sb-demos-card-title">{demo.title}</h3>
                                        <h4 className="sb-demos-card-subtitle">{demo.subtitle}</h4>
                                        <p className="sb-demos-card-desc">{demo.description}</p>
                                    </div>

                                    <div className="sb-demos-card-tags">
                                        {demo.tags.map(tag => (
                                            <span key={tag} className="sb-demos-tag">#{tag}</span>
                                        ))}
                                    </div>

                                    <div className="sb-demos-card-footer">
                                        <button
                                            className="sb-demos-launch-btn"
                                            onClick={() => onLaunchDemo(demo)}
                                        >
                                            <IconSparkles size={14} />
                                            <span>Launch Demo Stage</span>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Modal Footer */}
                <div className="sb-demos-footer">
                    <span className="sb-demos-footer-hint">
                        💡 Tip: Demos run natively within Scratchbox IDE's high-speed canvas engine with zero cloud latency.
                    </span>
                    <button className="sb-demos-done-btn" onClick={onClose}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
};
