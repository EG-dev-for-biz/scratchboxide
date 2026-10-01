/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { ChecklistCategory, ChecklistData, ChecklistItem } from '../canvas-types';

export interface ChecklistPrimitiveProps {
    data: ChecklistData;
    onUpdate?: (updatedData: ChecklistData) => void;
}

export const ChecklistPrimitive: React.FC<ChecklistPrimitiveProps> = ({ data, onUpdate }) => {
    const sanitizeChecklist = (raw: ChecklistData): ChecklistData => {
        let cats = raw?.categories || (raw as any)?.checklistCategories || [];
        if (!Array.isArray(cats) || cats.length === 0) {
            const rawItems = (raw as any)?.items || [];
            cats = [{
                id: 'cat-general',
                title: 'General Checklist',
                items: Array.isArray(rawItems) ? rawItems : []
            }];
        }
        return {
            title: raw?.title || (raw as any)?.checklistTitle || 'Actionable Checklist',
            description: raw?.description || (raw as any)?.checklistDescription,
            categories: cats.map((cat, idx) => ({
                id: cat.id || `cat-${idx}`,
                title: cat.title || 'Tasks',
                items: Array.isArray(cat.items) ? cat.items.map((it: any, iIdx: number) => ({
                    id: it.id || `item-${iIdx}`,
                    label: it.label || it.text || it.title || 'Task item',
                    completed: !!it.completed || !!it.done,
                    priority: it.priority || 'medium',
                    tag: it.tag,
                    tagColor: it.tagColor || 'blue',
                    notes: it.notes,
                    dueDate: it.dueDate
                })) : []
            }))
        };
    };

    const [checklist, setChecklist] = React.useState<ChecklistData>(() => sanitizeChecklist(data));
    const [newItemCategory, setNewItemCategory] = React.useState<string | undefined>(undefined);
    const [newItemText, setNewItemText] = React.useState<string>('');

    React.useEffect(() => {
        setChecklist(sanitizeChecklist(data));
    }, [data]);

    // Calculate total stats
    const categories = checklist.categories || [];
    const totalItems = categories.reduce((acc, cat) => acc + (cat.items?.length || 0), 0);
    const completedItems = categories.reduce(
        (acc, cat) => acc + (cat.items || []).filter(item => item.completed).length,
        0
    );
    const progressPercent = totalItems === 0 ? 0 : Math.round((completedItems / totalItems) * 100);

    const toggleItem = (categoryId: string, itemId: string) => {
        const newCategories = categories.map(cat => {
            if (cat.id === categoryId) {
                return {
                    ...cat,
                    items: (cat.items || []).map(item =>
                        item.id === itemId ? { ...item, completed: !item.completed } : item
                    )
                };
            }
            return cat;
        });

        const newChecklist = { ...checklist, categories: newCategories };
        setChecklist(newChecklist);
        if (onUpdate) {
            onUpdate(newChecklist);
        }
    };

    const handleAddItem = (categoryId: string) => {
        if (!newItemText.trim()) { return; }

        const newItem: ChecklistItem = {
            id: `item-${Date.now()}`,
            label: newItemText.trim(),
            completed: false,
            priority: 'medium'
        };

        const newCategories = categories.map(cat => {
            if (cat.id === categoryId) {
                return { ...cat, items: [...(cat.items || []), newItem] };
            }
            return cat;
        });

        const newChecklist = { ...checklist, categories: newCategories };
        setChecklist(newChecklist);
        setNewItemText('');
        setNewItemCategory(undefined);
        if (onUpdate) {
            onUpdate(newChecklist);
        }
    };

    const handleDeleteItem = (categoryId: string, itemId: string) => {
        const newCategories = categories.map(cat => {
            if (cat.id === categoryId) {
                return { ...cat, items: (cat.items || []).filter(i => i.id !== itemId) };
            }
            return cat;
        });

        const newChecklist = { ...checklist, categories: newCategories };
        setChecklist(newChecklist);
        if (onUpdate) {
            onUpdate(newChecklist);
        }
    };

    return (
        <div className="sb-primitive-checklist">
            {checklist.description && (
                <div className="sb-primitive-sub-header">
                    <p className="sb-primitive-subtitle">{checklist.description}</p>
                </div>
            )}

            {/* Overall Progress Tracker */}
            <div className="sb-checklist-progress-card">
                <div className="sb-progress-meta">
                    <span className="sb-progress-label">Task Completion Progress</span>
                    <span className="sb-progress-count">
                        {completedItems} of {totalItems} completed ({progressPercent}%)
                    </span>
                </div>
                <div className="sb-progress-bar-track">
                    <div
                        className="sb-progress-bar-fill"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>
            </div>

            {/* Categories */}
            <div className="sb-checklist-categories">
                {checklist.categories.map((category: ChecklistCategory) => {
                    const catTotal = category.items.length;
                    const catCompleted = category.items.filter(i => i.completed).length;

                    return (
                        <div key={category.id} className="sb-checklist-category-card">
                            <div className="sb-category-header">
                                <h4 className="sb-category-title">{category.title}</h4>
                                <span className="sb-category-badge">
                                    {catCompleted}/{catTotal}
                                </span>
                            </div>

                            <div className="sb-category-items">
                                {category.items.map(item => (
                                    <div
                                        key={item.id}
                                        className={`sb-checklist-item ${item.completed ? 'sb-item-done' : ''}`}
                                    >
                                        <label className="sb-checklist-checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={item.completed}
                                                onChange={() => toggleItem(category.id, item.id)}
                                            />
                                            <span className="sb-checkbox-custom" />
                                            <span className="sb-checklist-text">{item.label}</span>
                                        </label>

                                        <div className="sb-checklist-item-meta">
                                            {item.tag && (
                                                <span className={`sb-card-tag sb-tag-${item.tagColor || 'blue'}`}>
                                                    {item.tag}
                                                </span>
                                            )}
                                            {item.dueDate && (
                                                <span className="sb-item-due">{item.dueDate}</span>
                                            )}
                                            {item.priority && (
                                                <span className={`sb-priority-badge sb-priority-${item.priority}`}>
                                                    {item.priority}
                                                </span>
                                            )}
                                            <button
                                                className="sb-item-del-btn"
                                                title="Delete item"
                                                onClick={() => handleDeleteItem(category.id, item.id)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    </div>
                                ))}

                                {newItemCategory === category.id ? (
                                    <div className="sb-category-add-form">
                                        <input
                                            type="text"
                                            className="sb-input sb-input-sm"
                                            placeholder="New checklist item..."
                                            value={newItemText}
                                            autoFocus
                                            onChange={e => setNewItemText(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {handleAddItem(category.id); }
                                                if (e.key === 'Escape') {setNewItemCategory(undefined); }
                                            }}
                                        />
                                        <div className="sb-add-form-actions">
                                            <button
                                                className="sb-btn sb-btn-primary sb-btn-xs"
                                                onClick={() => handleAddItem(category.id)}
                                            >
                                                Add
                                            </button>
                                            <button
                                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                                onClick={() => setNewItemCategory(undefined)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        className="sb-add-checklist-item-btn"
                                        onClick={() => {
                                            setNewItemCategory(category.id);
                                            setNewItemText('');
                                        }}
                                    >
                                        + Add Item
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
