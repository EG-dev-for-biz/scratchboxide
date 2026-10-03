/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    AccentColor,
    DEFAULT_SKILLS_CATALOG,
    SkillCategory,
    SkillItem,
    SkillsManagerData
} from '../canvas-types';
import { IconClose } from '../canvas-icons';

export interface SkillsManagerPrimitiveProps {
    data?: SkillsManagerData;
    skills?: SkillItem[];
    onSkillsChange?: (skills: SkillItem[]) => void;
    onToggleSkill?: (skillId: string, enabled: boolean) => void;
    onSelectPromptStarter?: (prompt: string, skill: SkillItem) => void;
    onInstallSkill?: (newSkill: SkillItem) => void;
}

export const SkillsManagerPrimitive: React.FC<SkillsManagerPrimitiveProps> = ({
    data,
    skills: controlledSkills,
    onSkillsChange,
    onToggleSkill,
    onSelectPromptStarter,
    onInstallSkill
}) => {
    const [skillsList, setSkillsList] = React.useState<SkillItem[]>(
        controlledSkills || (data && data.skills) || DEFAULT_SKILLS_CATALOG
    );
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [selectedCategory, setSelectedCategory] = React.useState<string>('All');
    const [isDraggingOver, setIsDraggingOver] = React.useState<boolean>(false);
    const [isCreateModalOpen, setIsCreateModalOpen] = React.useState<boolean>(false);
    const [installedToast, setInstalledToast] = React.useState<string | undefined>(undefined);

    // Form state for creating custom skill
    const [customName, setCustomName] = React.useState<string>('');
    const [customTagline, setCustomTagline] = React.useState<string>('');
    const [customCategory, setCustomCategory] = React.useState<SkillCategory>('Custom');
    const [customColor, setCustomColor] = React.useState<AccentColor>('indigo');
    const [customPrompt, setCustomPrompt] = React.useState<string>('');
    const [customInstructions, setCustomInstructions] = React.useState<string>('');

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Synchronize if controlled prop updates
    React.useEffect(() => {
        if (controlledSkills) {
            setSkillsList(controlledSkills);
        } else if (data && data.skills) {
            setSkillsList(data.skills);
        }
    }, [controlledSkills, data]);

    const handleToggle = (skillId: string, currentEnabled: boolean) => {
        const updated = skillsList.map(s =>
            s.id === skillId ? { ...s, isEnabled: !currentEnabled } : s
        );
        setSkillsList(updated);
        if (onSkillsChange) {onSkillsChange(updated); }
        if (onToggleSkill) {onToggleSkill(skillId, !currentEnabled); }
    };

    const handleFileParseAndInstall = (fileName: string, content: string) => {
        // Extract title from markdown heading or filename
        const headingMatch = content.match(/^#\s+(.+)$/m);
        const name = headingMatch
            ? headingMatch[1].trim()
            : fileName.replace(/\.(md|skill)$/i, '').replace(/[-_]/g, ' ');

        // Extract description
        const cleanContent = content.replace(/^#.+$/m, '').trim();
        const firstParagraph = cleanContent.split('\n\n')[0] || 'Custom imported AI superpower instructions.';
        const tagline = firstParagraph.slice(0, 110) + (firstParagraph.length > 110 ? '...' : '');

        let category: SkillCategory = 'Custom';
        let accentColor: AccentColor = 'purple';

        const lower = (fileName + ' ' + content).toLowerCase();
        if (lower.includes('design') || lower.includes('ui') || lower.includes('css') || lower.includes('frontend')) {
            category = 'Design';
            accentColor = 'blue';
        } else if (lower.includes('data') || lower.includes('analyst') || lower.includes('chart') || lower.includes('metrics')) {
            category = 'Analytics';
            accentColor = 'emerald';
        } else if (lower.includes('copy') || lower.includes('write') || lower.includes('content') || lower.includes('doc')) {
            category = 'Writing';
            accentColor = 'purple';
        } else if (lower.includes('architect') || lower.includes('cloud') || lower.includes('backend') || lower.includes('api')) {
            category = 'Engineering';
            accentColor = 'amber';
        }

        const newSkill: SkillItem = {
            id: `skill-imported-${Date.now()}`,
            name: name.charAt(0).toUpperCase() + name.slice(1),
            tagline,
            description: cleanContent,
            icon: '',
            category,
            accentColor,
            tags: ['Imported', 'Custom', fileName.replace(/\..+$/, '')],
            isEnabled: true,
            isCustom: true,
            author: 'Workspace Import',
            version: '1.0.0',
            rawContent: content,
            dateAdded: new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }),
            promptStarters: [
                `Use the ${name} superpower to assist with this task`,
                `Apply ${name} guidelines to the active canvas`
            ]
        };

        const updated = [newSkill, ...skillsList];
        setSkillsList(updated);
        if (onSkillsChange) {onSkillsChange(updated); }
        if (onInstallSkill) {onInstallSkill(newSkill); }

        setInstalledToast(`Superpower "${newSkill.name}" installed and activated!`);
        setTimeout(() => setInstalledToast(undefined), 3500);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            const reader = new FileReader();
            reader.onload = event => {
                const text = event.target?.result as string;
                if (text) {
                    handleFileParseAndInstall(file.name, text);
                }
            };
            reader.readAsText(file);
        }
    };

    const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = event => {
                const text = event.target?.result as string;
                if (text) {
                    handleFileParseAndInstall(file.name, text);
                }
            };
            reader.readAsText(file);
        }
    };

    const handleCreateCustomSkill = (e: React.FormEvent) => {
        e.preventDefault();
        if (!customName.trim()) {return; }

        const newSkill: SkillItem = {
            id: `skill-custom-${Date.now()}`,
            name: customName.trim(),
            tagline: customTagline.trim() || 'Custom user-defined AI capability.',
            description: customInstructions.trim() || 'Tailored instructions for this specialized task.',
            icon: '',
            category: customCategory,
            accentColor: customColor,
            tags: ['Custom', customCategory],
            isEnabled: true,
            isCustom: true,
            author: 'You',
            version: '1.0.0',
            promptStarters: customPrompt.trim()
                ? [customPrompt.trim()]
                : [`Apply ${customName} to the current canvas`]
        };

        const updated = [newSkill, ...skillsList];
        setSkillsList(updated);
        if (onSkillsChange) {onSkillsChange(updated); }
        if (onInstallSkill) {onInstallSkill(newSkill); }

        setIsCreateModalOpen(false);
        setCustomName('');
        setCustomTagline('');
        setCustomInstructions('');
        setCustomPrompt('');

        setInstalledToast(`Superpower "${newSkill.name}" created!`);
        setTimeout(() => setInstalledToast(undefined), 3500);
    };

    const handleDeleteCustomSkill = (skillId: string) => {
        const updated = skillsList.filter(s => s.id !== skillId);
        setSkillsList(updated);
        if (onSkillsChange) {onSkillsChange(updated); }
    };

    const activeSkillsCount = skillsList.filter(s => s.isEnabled).length;

    const filteredSkills = skillsList.filter(skill => {
        const matchesCategory = selectedCategory === 'All' || skill.category === selectedCategory;
        const matchesSearch =
            !searchQuery.trim() ||
            skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            skill.tagline.toLowerCase().includes(searchQuery.toLowerCase()) ||
            skill.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()));
        return matchesCategory && matchesSearch;
    });

    const categories: { label: string; count: number }[] = [
        { label: 'All', count: skillsList.length },
        { label: 'Design', count: skillsList.filter(s => s.category === 'Design').length },
        { label: 'Analytics', count: skillsList.filter(s => s.category === 'Analytics').length },
        { label: 'Engineering', count: skillsList.filter(s => s.category === 'Engineering').length },
        { label: 'Writing', count: skillsList.filter(s => s.category === 'Writing').length },
        { label: 'Research', count: skillsList.filter(s => s.category === 'Research').length },
        { label: 'Custom', count: skillsList.filter(s => s.category === 'Custom').length }
    ];

    return (
        <div className="sb-skills-hub-container">
            {/* Header & Stats Banner */}
            <div className="sb-skills-hub-header">
                <div className="sb-skills-header-main">
                    <div className="sb-skills-title-row">
                        <div>
                            <h2 className="sb-skills-title">AI Skills &amp; Capabilities</h2>
                            <p className="sb-skills-subtitle">
                                Equip your AI companion with domain skills, 3D spatial pipelines, and specialized workflows.
                            </p>
                        </div>
                    </div>

                    <div className="sb-skills-meta-chips">
                        <div className="sb-skills-chip-active">
                            <span className="sb-chip-indicator" />
                            <span className="sb-chip-count">{activeSkillsCount} Active</span>
                        </div>
                        <div className="sb-skills-chip-total">
                            <span>{skillsList.length} Total Skills</span>
                        </div>
                    </div>
                </div>

                <div className="sb-skills-header-actions">
                    <button
                        className="sb-btn sb-btn-primary sb-btn-sm"
                        onClick={() => setIsCreateModalOpen(true)}
                    >
                        <span>+ New Skill</span>
                    </button>
                </div>
            </div>

            {/* Notification Toast */}
            {installedToast && (
                <div className="sb-apple-toast-banner">
                    <span className="sb-toast-message">{installedToast}</span>
                </div>
            )}

            {/* Drag & Drop Zone for SKILL.md */}
            <div
                className={`sb-skills-dropzone ${isDraggingOver ? 'sb-dropzone-active' : ''}`}
                onDragOver={e => {
                    e.preventDefault();
                    setIsDraggingOver(true);
                }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.skill,.txt"
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                />
                <div className="sb-dropzone-content">
                    <div className="sb-dropzone-text-group">
                        <span className="sb-dropzone-headline">
                            Drop <code>SKILL.md</code> or <code>.skill</code> files here to install
                        </span>
                        <span className="sb-dropzone-subline">
                            Instantly adds new domain logic, styling rules, or analytical guidelines to your studio.
                        </span>
                    </div>
                    <button
                        type="button"
                        className="sb-btn sb-btn-secondary sb-btn-xs"
                        onClick={e => {
                            e.stopPropagation();
                            fileInputRef.current?.click();
                        }}
                    >
                        Browse Files
                    </button>
                </div>
            </div>

            {/* Search & Category Filter Bar */}
            <div className="sb-skills-filter-toolbar">
                <div className="sb-skills-search-wrapper">
                    <input
                        type="text"
                        className="sb-skills-search-input"
                        placeholder="Search superpowers by name, tag, or capability..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                        <button
                            className="sb-search-clear-btn"
                            onClick={() => setSearchQuery('')}
                        >
                            <IconClose size={12} />
                        </button>
                    )}
                </div>

                <div className="sb-skills-category-tabs">
                    {categories.map(cat => (
                        <button
                            key={cat.label}
                            className={`sb-cat-tab-btn ${
                                selectedCategory === cat.label ? 'sb-cat-tab-active' : ''
                            }`}
                            onClick={() => setSelectedCategory(cat.label)}
                        >
                            <span>{cat.label}</span>
                            <span className="sb-cat-badge">{cat.count}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Superpowers Grid */}
            <div className="sb-skills-cards-grid">
                {filteredSkills.length > 0 ? (
                    filteredSkills.map(skill => {
                        const isEnabled = skill.isEnabled;
                        const accent = skill.accentColor || 'blue';

                        return (
                            <div
                                key={skill.id}
                                className={`sb-skill-card sb-accent-${accent} ${
                                    isEnabled ? 'sb-skill-card-enabled' : 'sb-skill-card-disabled'
                                }`}
                            >
                                <div className="sb-skill-card-top">
                                    <div className="sb-skill-heading">
                                        <div className="sb-skill-title-row">
                                            <h3 className="sb-skill-name">{skill.name}</h3>
                                            {skill.isCustom && (
                                                <span className="sb-custom-pill">Custom</span>
                                            )}
                                        </div>
                                        <span className="sb-skill-category-tag">
                                            {skill.category}
                                        </span>
                                    </div>

                                    {/* Tactile Apple-Style Switch */}
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={isEnabled}
                                        className={`sb-apple-switch ${isEnabled ? 'sb-switch-on' : 'sb-switch-off'}`}
                                        onClick={() => handleToggle(skill.id, isEnabled)}
                                        title={isEnabled ? 'Disable superpower' : 'Enable superpower'}
                                    >
                                        <span className="sb-switch-thumb" />
                                    </button>
                                </div>

                                <p className="sb-skill-tagline">{skill.tagline}</p>

                                {/* Tags */}
                                <div className="sb-skill-tags-list">
                                    {skill.tags.map((tag, idx) => (
                                        <span key={idx} className="sb-skill-tag-pill">
                                            {tag}
                                        </span>
                                    ))}
                                </div>

                                {/* Instant Prompt Starters */}
                                {skill.promptStarters && skill.promptStarters.length > 0 && (
                                    <div className="sb-skill-prompt-starters">
                                        <span className="sb-prompt-starters-label">Try this Superpower:</span>
                                        <div className="sb-starters-chips-row">
                                            {skill.promptStarters.map((starter, i) => (
                                                <button
                                                    key={i}
                                                    className="sb-starter-chip"
                                                    onClick={() => {
                                                        if (!isEnabled) {
                                                            handleToggle(skill.id, false);
                                                        }
                                                        if (onSelectPromptStarter) {
                                                            onSelectPromptStarter(starter, skill);
                                                        }
                                                    }}
                                                    title="Click to launch this prompt with this superpower"
                                                >
                                                    <span className="sb-starter-text">{starter}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Bottom Metadata & Actions */}
                                <div className="sb-skill-card-footer">
                                    <span className="sb-skill-author">
                                        by {skill.author || 'Scratchbox Lab'} • v{skill.version || '1.0'}
                                    </span>

                                    {skill.isCustom && (
                                        <button
                                            className="sb-btn-text-xs sb-skill-delete-btn"
                                            onClick={() => handleDeleteCustomSkill(skill.id)}
                                            title="Delete custom superpower"
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="sb-skills-empty-state">
                        <h4 className="sb-empty-title">No matching superpowers found</h4>
                        <p className="sb-empty-desc">
                            Try adjusting your search query or select another category filter.
                        </p>
                        <button
                            className="sb-btn sb-btn-secondary sb-btn-sm"
                            onClick={() => {
                                setSearchQuery('');
                                setSelectedCategory('All');
                            }}
                        >
                            Reset Filters
                        </button>
                    </div>
                )}
            </div>

            {/* Custom Superpower Modal */}
            {isCreateModalOpen && (
                <div className="sb-modal-backdrop" onClick={() => setIsCreateModalOpen(false)}>
                    <div className="sb-modal-card" onClick={e => e.stopPropagation()}>
                        <div className="sb-modal-header">
                            <div className="sb-modal-title-group">
                                <h3>Create Custom AI Superpower</h3>
                            </div>
                            <button
                                type="button"
                                className="sb-icon-button sb-icon-button-sm"
                                onClick={() => setIsCreateModalOpen(false)}
                            >
                                <IconClose size={12} />
                            </button>
                        </div>

                        <form onSubmit={handleCreateCustomSkill} className="sb-modal-form">
                            <div className="sb-form-group">
                                <label className="sb-form-label">Superpower Name</label>
                                <input
                                    type="text"
                                    required
                                    className="sb-form-input"
                                    placeholder="e.g. Conversion Rate Optimizer, Sentry Diagnostician"
                                    value={customName}
                                    onChange={e => setCustomName(e.target.value)}
                                />
                            </div>

                            <div className="sb-form-group">
                                <label className="sb-form-label">Category</label>
                                <select
                                    className="sb-form-select"
                                    value={customCategory}
                                    onChange={e => setCustomCategory(e.target.value as SkillCategory)}
                                >
                                    <option value="Design">Design</option>
                                    <option value="Analytics">Analytics</option>
                                    <option value="Engineering">Engineering</option>
                                    <option value="Writing">Writing</option>
                                    <option value="Research">Research</option>
                                    <option value="Custom">Custom</option>
                                </select>
                            </div>

                            <div className="sb-form-group">
                                <label className="sb-form-label">Accent Theme</label>
                                <div className="sb-color-swatches-row">
                                    {(['blue', 'indigo', 'emerald', 'amber', 'purple', 'rose', 'cyan'] as AccentColor[]).map(color => (
                                        <button
                                            key={color}
                                            type="button"
                                            className={`sb-color-swatch-btn sb-bg-${color} ${customColor === color ? 'sb-swatch-selected' : ''}`}
                                            onClick={() => setCustomColor(color)}
                                            title={color}
                                        />
                                    ))}
                                </div>
                            </div>

                            <div className="sb-form-group">
                                <label className="sb-form-label">Layman Tagline (What it does)</label>
                                <input
                                    type="text"
                                    className="sb-form-input"
                                    placeholder="e.g. Audits marketing copy and suggests high-converting headline alternatives."
                                    value={customTagline}
                                    onChange={e => setCustomTagline(e.target.value)}
                                />
                            </div>

                            <div className="sb-form-group">
                                <label className="sb-form-label">Sample Prompt Starter</label>
                                <input
                                    type="text"
                                    className="sb-form-input"
                                    placeholder="e.g. Audit this page for conversion bottlenecks"
                                    value={customPrompt}
                                    onChange={e => setCustomPrompt(e.target.value)}
                                />
                            </div>

                            <div className="sb-form-group">
                                <label className="sb-form-label">Superpower System Rules & Guidelines</label>
                                <textarea
                                    className="sb-form-textarea"
                                    rows={4}
                                    placeholder="Define the specific instructions, frameworks, or design constraints the AI should adopt..."
                                    value={customInstructions}
                                    onChange={e => setCustomInstructions(e.target.value)}
                                />
                            </div>

                            <div className="sb-modal-footer">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary"
                                    onClick={() => setIsCreateModalOpen(false)}
                                >
                                    Cancel
                                </button>
                                <button type="submit" className="sb-btn sb-btn-primary">
                                    Install Superpower
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
