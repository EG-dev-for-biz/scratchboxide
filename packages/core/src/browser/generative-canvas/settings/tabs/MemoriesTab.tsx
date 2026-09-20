/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Memories settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { IconClose, IconSearch, IconSparkles } from '../../canvas-icons';
import { PROJECT_CONTEXT_CATEGORIES, UserMemoryItem, VISUAL_STYLE_CATEGORIES, WRITING_STYLE_CATEGORIES, formatCategoryLabel, getMemoryCategoryGroup } from '../../canvas-types';
import { useSettingsContext } from '../SettingsContext';

export const MemoriesTab: React.FC = () => {
    const { confirmClearCategory, editingMemoryId, editingMemoryValue, expandedCategories, handleClearCategory, handleCreateMemory, handleCreateStylePreference, handleCreateWritingProfile, handleDeleteMemory, handleDeleteStylePreference, handleDeleteWritingProfile, handleSaveEditMemory, handleSetActiveWritingProfile, handleToggleMemoryInjection, isAddMemoryOpen, isAddProfileOpen, isAddStyleOpen, memories, memoriesConfig, memoriesFilterGroup, memorySearchQuery, newMemoryCategory, newMemoryKey, newMemoryScope, newMemoryValue, newProfileName, newProfilePrompt, newProfileSamples, newStyleCategory, newStyleDesc, newStyleIsDefault, newStyleName, newStylePrompt, setConfirmClearCategory, setEditingMemoryId, setEditingMemoryValue, setIsAddMemoryOpen, setIsAddProfileOpen, setIsAddStyleOpen, setMemoriesFilterGroup, setMemorySearchQuery, setNewMemoryCategory, setNewMemoryKey, setNewMemoryScope, setNewMemoryValue, setNewProfileName, setNewProfilePrompt, setNewProfileSamples, setNewStyleCategory, setNewStyleDesc, setNewStyleIsDefault, setNewStyleName, setNewStylePrompt, stylePreferences, toggleCategoryAccordion, writingProfiles } = useSettingsContext();
    const filteredMemories = memories.filter(m => {
        if (memoriesFilterGroup !== 'all') {
            if (getMemoryCategoryGroup(m.category) !== memoriesFilterGroup) {
                return false;
            }
        }
        if (memorySearchQuery.trim()) {
            const q = memorySearchQuery.toLowerCase().trim();
            return (
                m.key.toLowerCase().includes(q) ||
                m.value.toLowerCase().includes(q) ||
                m.category.toLowerCase().includes(q) ||
                formatCategoryLabel(m.category).toLowerCase().includes(q)
            );
        }
        return true;
    });

    const groupedMemories = filteredMemories.reduce<Record<string, UserMemoryItem[]>>((acc, item) => {
        if (!acc[item.category]) {
            acc[item.category] = [];
        }
        acc[item.category].push(item);
        return acc;
    }, {});

    const writingCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'writing').length;
    const visualCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'visual').length;
    const projectCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'project').length;

    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <div className="flex items-center justify-between mb-2">
                <div>
                    <h2 className="sb-cursor-content-title">User Memories</h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Manage persistent memory banks, writing style voice profiles, visual aesthetics, and project facts.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm flex items-center gap-1.5"
                        onClick={() => setIsAddMemoryOpen(!isAddMemoryOpen)}
                    >
                        <IconSparkles size={13} />
                        <span>{isAddMemoryOpen ? 'Close Form' : '+ Add Memory'}</span>
                    </button>
                </div>
            </div>

            {/* Memory Injection Toggle Card */}
            <div className="sb-cursor-group-card mb-4">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title flex items-center gap-2">
                            <span>Inject memories into AI generation</span>
                            <span className="sb-badge-unified sb-badge-blue">ACTIVE</span>
                        </div>
                        <div className="sb-cursor-row-desc">
                            Automatically supply active writing voice profiles, visual presets, and project facts to Gemini 3.7 Flash and subagent orchestrators.
                        </div>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={memoriesConfig.enableMemoryInjection}
                        className={`sb-cursor-toggle ${memoriesConfig.enableMemoryInjection ? 'sb-cursor-toggle-on' : ''}`}
                        onClick={handleToggleMemoryInjection}
                    >
                        <span className="sb-cursor-toggle-thumb" />
                    </button>
                </div>
            </div>

            {/* Filter Sub-Tabs / Segments */}
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <div className="flex items-center gap-1 bg-zinc-100/80 dark:bg-zinc-900/80 p-1 rounded-xl border border-zinc-200 dark:border-zinc-800/80">
                    <button
                        type="button"
                        className={`sb-segment-btn ${memoriesFilterGroup === 'all' ? 'sb-segment-active' : ''}`}
                        onClick={() => setMemoriesFilterGroup('all')}
                    >
                        All Memories ({memories.length})
                    </button>
                    <button
                        type="button"
                        className={`sb-segment-btn ${memoriesFilterGroup === 'writing' ? 'sb-segment-active' : ''}`}
                        onClick={() => setMemoriesFilterGroup('writing')}
                    >
                        Writing Style ({writingCount})
                    </button>
                    <button
                        type="button"
                        className={`sb-segment-btn ${memoriesFilterGroup === 'visual' ? 'sb-segment-active' : ''}`}
                        onClick={() => setMemoriesFilterGroup('visual')}
                    >
                        Image & Video Style ({visualCount})
                    </button>
                    <button
                        type="button"
                        className={`sb-segment-btn ${memoriesFilterGroup === 'project' ? 'sb-segment-active' : ''}`}
                        onClick={() => setMemoriesFilterGroup('project')}
                    >
                        Project Entities ({projectCount})
                    </button>
                </div>

                {/* Search Filter Input */}
                <div className="relative min-w-[220px]">
                    <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                    <input
                        type="text"
                        className="sb-cursor-text-input pl-8 py-1.5 h-9 text-xs w-full"
                        placeholder="Filter memories & keys..."
                        value={memorySearchQuery}
                        onChange={e => setMemorySearchQuery(e.target.value)}
                    />
                </div>
            </div>

            {/* Add Memory Inline Form Drawer */}
            {isAddMemoryOpen && (
                <form onSubmit={handleCreateMemory} className="sb-cursor-group-card p-4 mb-4 space-y-3 bg-zinc-900/90 border-blue-500/30">
                    <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                        <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                            <IconSparkles size={13} className="text-blue-400" />
                            <span>Record New User Memory</span>
                        </div>
                        <button
                            type="button"
                            className="sb-btn-ghost sb-icon-button text-zinc-400 hover:text-zinc-200"
                            onClick={() => setIsAddMemoryOpen(false)}
                        >
                            <IconClose size={13} />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Category</label>
                            <select
                                className="sb-cursor-select-dropdown w-full"
                                value={newMemoryCategory}
                                onChange={e => setNewMemoryCategory(e.target.value as any)}
                            >
                                <optgroup label="Writing Style">
                                    {WRITING_STYLE_CATEGORIES.map(c => (
                                        <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                    ))}
                                </optgroup>
                                <optgroup label="Visual Style">
                                    {VISUAL_STYLE_CATEGORIES.map(c => (
                                        <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                    ))}
                                </optgroup>
                                <optgroup label="Project Context & Entities">
                                    {PROJECT_CONTEXT_CATEGORIES.map(c => (
                                        <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                    ))}
                                </optgroup>
                            </select>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Memory Key / Identifier</label>
                            <input
                                type="text"
                                className="sb-cursor-text-input w-full"
                                placeholder="e.g., tone_preference, brand_color, lead_actor"
                                value={newMemoryKey}
                                onChange={e => setNewMemoryKey(e.target.value)}
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-zinc-400 mb-1">Memory Value / Fact</label>
                        <textarea
                            className="sb-cursor-text-input w-full h-20 resize-y"
                            placeholder="Enter memory instruction or grounded fact..."
                            value={newMemoryValue}
                            onChange={e => setNewMemoryValue(e.target.value)}
                            required
                        />
                    </div>

                    <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-3">
                            <label className="text-xs text-zinc-400 font-medium">Scope:</label>
                            <label className="flex items-center gap-1 text-xs text-zinc-300 cursor-pointer">
                                <input
                                    type="radio"
                                    name="memoryScope"
                                    value="global"
                                    checked={newMemoryScope === 'global'}
                                    onChange={() => setNewMemoryScope('global')}
                                />
                                <span>Global (All Projects)</span>
                            </label>
                            <label className="flex items-center gap-1 text-xs text-zinc-300 cursor-pointer">
                                <input
                                    type="radio"
                                    name="memoryScope"
                                    value="workspace"
                                    checked={newMemoryScope === 'workspace'}
                                    onChange={() => setNewMemoryScope('workspace')}
                                />
                                <span>Workspace Only</span>
                            </label>
                        </div>

                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={() => setIsAddMemoryOpen(false)}
                            >
                                <span>Cancel</span>
                            </button>
                            <button
                                type="submit"
                                className="sb-btn sb-btn-primary sb-btn-sm"
                            >
                                <span>Save Memory</span>
                            </button>
                        </div>
                    </div>
                </form>
            )}

            {/* Writing Style Profiles Section */}
            {(memoriesFilterGroup === 'all' || memoriesFilterGroup === 'writing') && (
                <div className="sb-cursor-section-block mb-4">
                    <div className="flex items-center justify-between sb-cursor-section-header">
                        <div className="flex items-center gap-2">
                            <span>Writing Style Profiles</span>
                            <span className="sb-badge-unified sb-badge-blue">{writingProfiles.length}</span>
                        </div>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400"
                            onClick={() => setIsAddProfileOpen(!isAddProfileOpen)}
                        >
                            {isAddProfileOpen ? 'Cancel' : '+ New Profile'}
                        </button>
                    </div>

                    {isAddProfileOpen && (
                        <form onSubmit={handleCreateWritingProfile} className="sb-cursor-group-card p-4 mb-3 space-y-3 bg-zinc-900/90 border-blue-500/30">
                            <div className="text-xs font-semibold text-zinc-200">Create Writing Style Voice Profile</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-400 mb-1">Profile Name</label>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input w-full"
                                        placeholder="e.g., Executive Cupertino Voice, Technical RFC Spec"
                                        value={newProfileName}
                                        onChange={e => setNewProfileName(e.target.value)}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-zinc-400 mb-1">Sample Reference Quotes (one per line)</label>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input w-full"
                                        placeholder="Sample quotes representing voice..."
                                        value={newProfileSamples}
                                        onChange={e => setNewProfileSamples(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-zinc-400 mb-1">Style Prompt Instructions</label>
                                <textarea
                                    className="sb-cursor-text-input w-full h-16 resize-y"
                                    placeholder="Describe the cadence, vocabulary, rhythm, and tone..."
                                    value={newProfilePrompt}
                                    onChange={e => setNewProfilePrompt(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="flex justify-end gap-2">
                                <button type="button" className="sb-cursor-row-btn" onClick={() => setIsAddProfileOpen(false)}>Cancel</button>
                                <button type="submit" className="sb-btn sb-btn-primary sb-btn-sm">Save Profile</button>
                            </div>
                        </form>
                    )}

                    <div className="sb-cursor-group-card">
                        {writingProfiles.length === 0 ? (
                            <div className="p-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
                                No writing style profiles configured yet. Add a profile to guide AI voice.
                            </div>
                        ) : (
                            writingProfiles.map(profile => (
                                <div key={profile.id} className="sb-cursor-row-item flex items-center justify-between p-3 border-b border-zinc-200 dark:border-zinc-800/60 last:border-0">
                                    <div className="space-y-1 max-w-[70%]">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{profile.name}</span>
                                            {profile.isActive && (
                                                <span className="sb-badge-unified sb-badge-blue font-bold">ACTIVE VOICE</span>
                                            )}
                                        </div>
                                        <div className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">{profile.stylePrompt}</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {!profile.isActive && (
                                            <button
                                                type="button"
                                                className="sb-cursor-row-btn"
                                                onClick={() => handleSetActiveWritingProfile(profile.id)}
                                            >
                                                <span>Set Active</span>
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-red-400 text-xs px-2 py-1"
                                            onClick={() => handleDeleteWritingProfile(profile.id)}
                                            title="Delete Profile"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Image & Video Style Preferences Section */}
            {(memoriesFilterGroup === 'all' || memoriesFilterGroup === 'visual') && (
                <div className="sb-cursor-section-block mb-4">
                    <div className="flex items-center justify-between sb-cursor-section-header">
                        <div className="flex items-center gap-2">
                            <span>Visual & Cinematic Style Presets</span>
                            <span className="sb-badge-unified sb-badge-purple">{stylePreferences.length}</span>
                        </div>
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400"
                            onClick={() => setIsAddStyleOpen(!isAddStyleOpen)}
                        >
                            {isAddStyleOpen ? 'Cancel' : '+ New Preset'}
                        </button>
                    </div>

                    {isAddStyleOpen && (
                        <form onSubmit={handleCreateStylePreference} className="sb-cursor-group-card p-4 mb-3 space-y-3 bg-zinc-900/90 border-purple-500/30">
                            <div className="text-xs font-semibold text-zinc-200">Create Visual / Video Style Preset</div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-400 mb-1">Preset Name</label>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input w-full"
                                        placeholder="e.g., Liquid Glass Studio, Cyberpunk Drone"
                                        value={newStyleName}
                                        onChange={e => setNewStyleName(e.target.value)}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-zinc-400 mb-1">Category</label>
                                    <select
                                        className="sb-cursor-select-dropdown w-full"
                                        value={newStyleCategory}
                                        onChange={e => setNewStyleCategory(e.target.value)}
                                    >
                                        <option value="visual_composition">Visual Composition</option>
                                        <option value="image_style">Image Style</option>
                                        <option value="video_style">Video Style</option>
                                        <option value="style_preferences">General Style</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-zinc-400 mb-1">Short Description</label>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input w-full"
                                        placeholder="e.g., Frosted glass and vibrant speculars"
                                        value={newStyleDesc}
                                        onChange={e => setNewStyleDesc(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-zinc-400 mb-1">Visual Prompt Directives</label>
                                <textarea
                                    className="sb-cursor-text-input w-full h-16 resize-y"
                                    placeholder="Enter camera angles, lighting conditions, materials, and color palettes..."
                                    value={newStylePrompt}
                                    onChange={e => setNewStylePrompt(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={newStyleIsDefault}
                                        onChange={e => setNewStyleIsDefault(e.target.checked)}
                                    />
                                    <span>Set as Default Visual Preset</span>
                                </label>
                                <div className="flex gap-2">
                                    <button type="button" className="sb-cursor-row-btn" onClick={() => setIsAddStyleOpen(false)}>Cancel</button>
                                    <button type="submit" className="sb-btn sb-btn-primary sb-btn-sm">Save Preset</button>
                                </div>
                            </div>
                        </form>
                    )}

                    <div className="sb-cursor-group-card">
                        {stylePreferences.length === 0 ? (
                            <div className="p-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
                                No visual presets created yet.
                            </div>
                        ) : (
                            stylePreferences.map(style => (
                                <div key={style.id} className="sb-cursor-row-item flex items-center justify-between p-3 border-b border-zinc-200 dark:border-zinc-800/60 last:border-0">
                                    <div className="space-y-1 max-w-[70%]">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{style.name}</span>
                                            {style.isDefault && (
                                                <span className="sb-badge-unified sb-badge-purple font-bold">DEFAULT PRESET</span>
                                            )}
                                            <span className="sb-badge-unified sb-badge-zinc">{formatCategoryLabel(style.category)}</span>
                                        </div>
                                        <div className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2">{style.stylePrompt}</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-red-400 text-xs px-2 py-1"
                                        onClick={() => handleDeleteStylePreference(style.id)}
                                        title="Delete Preset"
                                    >
                                        Delete
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Category Accordions & Memory Items */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header flex items-center justify-between">
                    <span>Learned Memory Banks ({filteredMemories.length} Facts)</span>
                </div>

                {Object.keys(groupedMemories).length === 0 ? (
                    <div className="sb-cursor-group-card p-6 text-center space-y-2">
                        <IconSparkles size={22} className="text-blue-400 mx-auto" />
                        <div className="text-sm font-semibold text-zinc-200">No memories found</div>
                        <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                            {memorySearchQuery
                                ? `No memories matched "${memorySearchQuery}". Try clearing search filter.`
                                : 'No memories recorded in this category. Click "+ Add Memory" to add your first entry.'}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {Object.entries(groupedMemories).map(([cat, items]) => {
                            const isExpanded = expandedCategories[cat] !== false; // expanded by default
                            const catGroup = getMemoryCategoryGroup(cat);
                            const groupBadgeColor =
                                catGroup === 'writing' ? 'sb-badge-blue' :
                                catGroup === 'visual' ? 'sb-badge-purple' : 'sb-badge-emerald';

                            return (
                                <div key={cat} className="sb-cursor-group-card overflow-hidden">
                                    {/* Accordion Header */}
                                    <div
                                        className="flex items-center justify-between p-3.5 bg-zinc-900/90 cursor-pointer hover:bg-zinc-800/40 select-none border-b border-zinc-800/80"
                                        onClick={() => toggleCategoryAccordion(cat)}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-zinc-400 font-mono transition-transform duration-200 inline-block">
                                                {isExpanded ? '▼' : '▶'}
                                            </span>
                                            <span className="text-xs font-semibold text-zinc-200">
                                                {formatCategoryLabel(cat)}
                                            </span>
                                            <span className="sb-badge-unified sb-badge-zinc">
                                                {items.length}
                                            </span>
                                            <span className={`sb-badge-unified ${groupBadgeColor} uppercase`}>
                                                {catGroup}
                                            </span>
                                        </div>

                                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                            {confirmClearCategory === cat ? (
                                                <div className="flex items-center gap-1.5 bg-red-950/80 px-2 py-1 rounded-lg border border-red-800">
                                                    <span className="text-xs text-red-300 font-medium">Clear all {items.length}?</span>
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-btn-danger sb-btn-xs px-2 py-0.5"
                                                        onClick={() => handleClearCategory(cat)}
                                                    >
                                                        Yes
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-400 hover:text-zinc-200 px-1"
                                                        onClick={() => setConfirmClearCategory(null)}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-ghost sb-btn-xs text-xs text-zinc-500 hover:text-red-400 px-2 py-0.5 rounded hover:bg-zinc-800/60"
                                                    onClick={() => setConfirmClearCategory(cat)}
                                                    title="Clear all memories in this category"
                                                >
                                                    Clear Category
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Accordion Body */}
                                    {isExpanded && (
                                        <div className="divide-y divide-zinc-200 dark:divide-zinc-800/60">
                                            {items.map(item => (
                                                <div key={item.id} className="p-3.5 hover:bg-zinc-100/60 dark:hover:bg-zinc-900/40 transition-colors">
                                                    <div className="flex items-center justify-between mb-1.5">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono text-xs font-semibold text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-800/30">
                                                                {item.key}
                                                            </span>
                                                            <span className={`sb-badge-unified ${item.scope === 'workspace' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                                                {item.scope === 'workspace' ? 'Workspace' : 'Global'}
                                                            </span>
                                                        </div>

                                                        <div className="flex items-center gap-2">
                                                            {editingMemoryId === item.id ? (
                                                                <>
                                                                    <button
                                                                        type="button"
                                                                        className="sb-btn sb-btn-primary sb-btn-xs px-2 py-0.5"
                                                                        onClick={() => handleSaveEditMemory(item.id)}
                                                                    >
                                                                        Save
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="sb-cursor-row-btn text-xs px-2 py-0.5"
                                                                        onClick={() => {
                                                                            setEditingMemoryId(null);
                                                                            setEditingMemoryValue('');
                                                                        }}
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <button
                                                                        type="button"
                                                                        className="sb-btn sb-btn-ghost sb-btn-xs px-1.5 py-0.5"
                                                                        onClick={() => {
                                                                            setEditingMemoryId(item.id);
                                                                            setEditingMemoryValue(item.value);
                                                                        }}
                                                                    >
                                                                        Edit
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="sb-btn sb-btn-ghost sb-btn-xs px-1.5 py-0.5"
                                                                        onClick={() => handleDeleteMemory(item.id)}
                                                                        title="Delete Memory"
                                                                    >
                                                                        Delete
                                                                    </button>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {editingMemoryId === item.id ? (
                                                        <textarea
                                                            className="sb-cursor-text-input w-full h-16 text-xs resize-y mt-1"
                                                            value={editingMemoryValue}
                                                            onChange={e => setEditingMemoryValue(e.target.value)}
                                                        />
                                                    ) : (
                                                        <div className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
                                                            {item.value}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};
