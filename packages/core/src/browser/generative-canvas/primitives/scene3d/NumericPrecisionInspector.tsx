/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useState, useMemo, useCallback } from 'react';
import * as THREE from 'three';
import type { Scene3DData } from '../../canvas-types';
import type { CustomMeshDefinition } from './syncCustomMeshes';

export interface NumericPrecisionInspectorProps {
    isOpen: boolean;
    onToggleOpen: () => void;
    selectedObjectId: string | null;
    selectedObjectName?: string;
    sceneData: Scene3DData;
    mutateSceneData: (
        mutator: (prev: Scene3DData) => Scene3DData,
        opInfo?: { operator: string; params?: any }
    ) => void;
    onSelectObject: (id: string | null) => void;
    threeObject?: THREE.Object3D | null;
}

const MATERIAL_PRESETS = [
    { id: 'custom', name: 'Custom PBR' },
    { id: 'titanium', name: 'Titanium Aerospace' },
    { id: 'gold', name: 'Polished Gold' },
    { id: 'chrome', name: 'Mirror Chrome' },
    { id: 'basalt', name: 'Volcanic Basalt' },
    { id: 'oak', name: 'Aged Timber' },
    { id: 'concrete', name: 'Cast Concrete' },
    { id: 'clay', name: 'Studio Clay' }
];

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export const NumericPrecisionInspector: React.FC<NumericPrecisionInspectorProps> = ({
    isOpen,
    onToggleOpen,
    selectedObjectId,
    selectedObjectName,
    sceneData,
    mutateSceneData,
    onSelectObject,
    threeObject
}) => {
    const [activeTab, setActiveTab] = useState<'transform' | 'hierarchy'>('transform');
    const [searchFilter, setSearchFilter] = useState('');

    const customMeshes = sceneData.customMeshes || [];

    // Find the currently selected custom mesh definition
    const selectedMesh = useMemo(() => {
        if (!selectedObjectId) return null;
        return customMeshes.find(m => m.id === selectedObjectId || m.name === selectedObjectId) || null;
    }, [customMeshes, selectedObjectId]);

    // Position values (fallback to threeObject or [0,0,0])
    const pos = useMemo<[number, number, number]>(() => {
        if (selectedMesh?.position) return selectedMesh.position;
        if (threeObject) return [threeObject.position.x, threeObject.position.y, threeObject.position.z];
        return [0, 0, 0];
    }, [selectedMesh, threeObject]);

    // Rotation values in degrees
    const rotDeg = useMemo<[number, number, number]>(() => {
        if (selectedMesh?.rotation) {
            return [
                Math.round(selectedMesh.rotation[0] * RAD2DEG * 10) / 10,
                Math.round(selectedMesh.rotation[1] * RAD2DEG * 10) / 10,
                Math.round(selectedMesh.rotation[2] * RAD2DEG * 10) / 10
            ];
        }
        if (threeObject) {
            return [
                Math.round(threeObject.rotation.x * RAD2DEG * 10) / 10,
                Math.round(threeObject.rotation.y * RAD2DEG * 10) / 10,
                Math.round(threeObject.rotation.z * RAD2DEG * 10) / 10
            ];
        }
        return [0, 0, 0];
    }, [selectedMesh, threeObject]);

    // Scale values
    const scl = useMemo<[number, number, number]>(() => {
        if (selectedMesh?.scale) return selectedMesh.scale;
        if (threeObject) return [threeObject.scale.x, threeObject.scale.y, threeObject.scale.z];
        return [1, 1, 1];
    }, [selectedMesh, threeObject]);

    // Material parameters
    const mat = useMemo(() => {
        const m = selectedMesh?.material || {};
        const preset = m.preset || 'custom';
        const roughness = typeof m.roughness === 'number' ? m.roughness : 0.5;
        const metalness = typeof m.metalness === 'number' ? m.metalness : 0.1;
        let hexColor = '#808080';
        if (typeof m.color === 'number') {
            hexColor = '#' + m.color.toString(16).padStart(6, '0');
        } else if (typeof m.color === 'string') {
            hexColor = m.color.startsWith('#') ? m.color : `#${m.color}`;
        }
        return { preset, roughness, metalness, hexColor };
    }, [selectedMesh]);

    // Dispatch transform updates
    const handleUpdateTransform = useCallback((
        newPos?: [number, number, number],
        newRotDeg?: [number, number, number],
        newScl?: [number, number, number]
    ) => {
        if (!selectedObjectId) return;

        const effectivePos = newPos || pos;
        const effectiveRotRad: [number, number, number] = newRotDeg
            ? [newRotDeg[0] * DEG2RAD, newRotDeg[1] * DEG2RAD, newRotDeg[2] * DEG2RAD]
            : (selectedMesh?.rotation || [0, 0, 0]);
        const effectiveScl = newScl || scl;

        // Immediately update threeObject if present
        if (threeObject) {
            if (newPos) threeObject.position.set(newPos[0], newPos[1], newPos[2]);
            if (newRotDeg) threeObject.rotation.set(effectiveRotRad[0], effectiveRotRad[1], effectiveRotRad[2]);
            if (newScl) threeObject.scale.set(newScl[0], newScl[1], newScl[2]);
        }

        mutateSceneData(prev => {
            const meshes = (prev.customMeshes || []).map(m => {
                if (m.id === selectedObjectId || m.name === selectedObjectId) {
                    return {
                        ...m,
                        position: effectivePos,
                        rotation: effectiveRotRad,
                        scale: effectiveScl
                    };
                }
                return m;
            });
            return { ...prev, customMeshes: meshes };
        }, {
            operator: 'sb_set_transform',
            params: {
                objectId: selectedObjectId,
                position: effectivePos,
                rotation: effectiveRotRad,
                scale: effectiveScl
            }
        });
    }, [selectedObjectId, pos, scl, selectedMesh, threeObject, mutateSceneData]);

    // Dispatch parent change (hierarchical scene graph)
    const handleUpdateParent = useCallback((newParentId: string) => {
        if (!selectedObjectId) return;
        const targetParentId = newParentId === '' ? undefined : newParentId;

        mutateSceneData(prev => {
            const meshes = (prev.customMeshes || []).map(m => {
                if (m.id === selectedObjectId || m.name === selectedObjectId) {
                    const next = { ...m };
                    if (targetParentId) {
                        next.parentId = targetParentId;
                    } else {
                        delete next.parentId;
                    }
                    return next;
                }
                return m;
            });
            return { ...prev, customMeshes: meshes };
        }, {
            operator: 'sb_reparent_mesh',
            params: {
                objectId: selectedObjectId,
                parentId: targetParentId || null
            }
        });
    }, [selectedObjectId, mutateSceneData]);

    // Dispatch material change
    const handleUpdateMaterial = useCallback((delta: { preset?: string; roughness?: number; metalness?: number; color?: string }) => {
        if (!selectedObjectId) return;

        mutateSceneData(prev => {
            const meshes = (prev.customMeshes || []).map(m => {
                if (m.id === selectedObjectId || m.name === selectedObjectId) {
                    const currentMat = m.material || {};
                    const nextMat = { ...currentMat };
                    if (delta.preset !== undefined) nextMat.preset = delta.preset;
                    if (delta.roughness !== undefined) nextMat.roughness = delta.roughness;
                    if (delta.metalness !== undefined) nextMat.metalness = delta.metalness;
                    if (delta.color !== undefined) {
                        nextMat.color = parseInt(delta.color.replace('#', ''), 16);
                    }
                    return { ...m, material: nextMat };
                }
                return m;
            });
            return { ...prev, customMeshes: meshes };
        }, {
            operator: 'sb_set_material',
            params: {
                objectId: selectedObjectId,
                ...delta
            }
        });
    }, [selectedObjectId, mutateSceneData]);

    // Reset transform
    const handleResetTransform = useCallback(() => {
        handleUpdateTransform([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    }, [handleUpdateTransform]);

    // Delete mesh
    const handleDeleteMesh = useCallback((id: string) => {
        mutateSceneData(prev => {
            const meshes = (prev.customMeshes || []).filter(m => m.id !== id && m.name !== id);
            return { ...prev, customMeshes: meshes };
        }, {
            operator: 'sb_delete_mesh',
            params: { objectId: id }
        });
        if (selectedObjectId === id) {
            onSelectObject(null);
        }
    }, [selectedObjectId, onSelectObject, mutateSceneData]);

    // Add primitive
    const handleAddPrimitive = useCallback((type: 'box' | 'cylinder' | 'sphere' | 'torus') => {
        const id = `${type}-${Date.now().toString(36)}`;
        const name = `${type.charAt(0).toUpperCase() + type.slice(1)} ${customMeshes.length + 1}`;
        const newMesh: NonNullable<Scene3DData['customMeshes']>[number] = {
            id,
            name,
            type,
            position: [0, type === 'box' ? 0.5 : 1, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            material: {
                preset: 'custom',
                roughness: 0.4,
                metalness: 0.1,
                color: 0x94a3b8
            }
        };

        mutateSceneData(prev => ({
            ...prev,
            customMeshes: [...(prev.customMeshes || []), newMesh]
        }), {
            operator: 'sb_create_mesh',
            params: { mesh: newMesh }
        });

        onSelectObject(id);
    }, [customMeshes.length, mutateSceneData, onSelectObject]);

    if (!isOpen) return null;

    // Filtered hierarchy list
    const filteredMeshes = customMeshes.filter(m => {
        if (!searchFilter) return true;
        const q = searchFilter.toLowerCase();
        return (m.name || '').toLowerCase().includes(q) || (m.id || '').toLowerCase().includes(q) || (m.type || '').toLowerCase().includes(q);
    });

    return (
        <div
            className="sb-3d-numeric-inspector absolute top-14 right-3 z-30 bottom-16 w-80 flex flex-col rounded-2xl bg-[#121216]/95 backdrop-blur-2xl border border-white/10 shadow-2xl text-xs font-mono select-none pointer-events-auto overflow-hidden animate-fadeIn"
            style={{ maxHeight: 'calc(100% - 120px)' }}
        >
            {/* Header & Tabs */}
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <span className="text-[11px] font-bold tracking-wider text-zinc-200 uppercase">Studio Inspector</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={onToggleOpen}
                        className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-all"
                        title="Close Inspector"
                    >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Navigation Switcher */}
            <div className="grid grid-cols-2 p-1.5 bg-black/20 border-b border-white/5 text-[10px]">
                <button
                    type="button"
                    onClick={() => setActiveTab('transform')}
                    className={`py-1 rounded-md font-semibold transition-all ${
                        activeTab === 'transform'
                            ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40 shadow-sm'
                            : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                    Transforms & PBR
                </button>
                <button
                    type="button"
                    onClick={() => setActiveTab('hierarchy')}
                    className={`py-1 rounded-md font-semibold transition-all ${
                        activeTab === 'hierarchy'
                            ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40 shadow-sm'
                            : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                    Hierarchy ({customMeshes.length})
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-4 custom-scrollbar">
                {activeTab === 'transform' ? (
                    selectedObjectId ? (
                        <>
                            {/* Selected Object Banner */}
                            <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">Active Object</span>
                                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-950/60 border border-blue-500/30 text-blue-300 uppercase">
                                        {selectedMesh?.type || 'Mesh'}
                                    </span>
                                </div>
                                <div className="text-zinc-200 font-bold truncate text-[11px]">
                                    {selectedMesh?.name || selectedObjectName || selectedObjectId}
                                </div>
                                <div className="text-[9px] text-zinc-500 truncate">
                                    ID: {selectedObjectId}
                                </div>

                                {/* Hierarchy Parent Selector */}
                                <div className="pt-1.5 border-t border-white/5 flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-zinc-400">Parent:</span>
                                    <select
                                        value={selectedMesh?.parentId || ''}
                                        onChange={(e) => handleUpdateParent(e.target.value)}
                                        className="flex-1 bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-zinc-200 focus:outline-none focus:border-blue-500"
                                    >
                                        <option value="">Root (Scene World)</option>
                                        {customMeshes
                                            .filter(m => m.id !== selectedObjectId && m.name !== selectedObjectId)
                                            .map(m => (
                                                <option key={m.id || m.name} value={m.id || m.name}>
                                                    {m.name || m.id}
                                                </option>
                                            ))
                                        }
                                    </select>
                                </div>
                            </div>

                            {/* Position Controls */}
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-semibold">
                                    <span>POSITION (M)</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                                        <div key={axis} className="flex items-center rounded-lg bg-black/30 border border-white/10 px-2 py-1 focus-within:border-blue-500">
                                            <span className={`text-[10px] font-bold mr-1.5 ${i === 0 ? 'text-rose-400' : i === 1 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                {axis}
                                            </span>
                                            <input
                                                type="number"
                                                step="0.1"
                                                value={pos[i]}
                                                onChange={(e) => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const nextPos: [number, number, number] = [...pos];
                                                    nextPos[i] = val;
                                                    handleUpdateTransform(nextPos, undefined, undefined);
                                                }}
                                                className="w-full bg-transparent text-right text-zinc-200 text-[10px] focus:outline-none"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Rotation Controls */}
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-semibold">
                                    <span>ROTATION (DEG)</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                                        <div key={axis} className="flex items-center rounded-lg bg-black/30 border border-white/10 px-2 py-1 focus-within:border-blue-500">
                                            <span className={`text-[10px] font-bold mr-1.5 ${i === 0 ? 'text-rose-400' : i === 1 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                {axis}
                                            </span>
                                            <input
                                                type="number"
                                                step="1"
                                                value={rotDeg[i]}
                                                onChange={(e) => {
                                                    const val = parseFloat(e.target.value) || 0;
                                                    const nextRot: [number, number, number] = [...rotDeg];
                                                    nextRot[i] = val;
                                                    handleUpdateTransform(undefined, nextRot, undefined);
                                                }}
                                                className="w-full bg-transparent text-right text-zinc-200 text-[10px] focus:outline-none"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Scale Controls */}
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-semibold">
                                    <span>SCALE</span>
                                </div>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                                        <div key={axis} className="flex items-center rounded-lg bg-black/30 border border-white/10 px-2 py-1 focus-within:border-blue-500">
                                            <span className={`text-[10px] font-bold mr-1.5 ${i === 0 ? 'text-rose-400' : i === 1 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                                {axis}
                                            </span>
                                            <input
                                                type="number"
                                                step="0.1"
                                                value={scl[i]}
                                                onChange={(e) => {
                                                    const val = parseFloat(e.target.value) || 0.001;
                                                    const nextScl: [number, number, number] = [...scl];
                                                    nextScl[i] = val;
                                                    handleUpdateTransform(undefined, undefined, nextScl);
                                                }}
                                                className="w-full bg-transparent text-right text-zinc-200 text-[10px] focus:outline-none"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Quick Transform Reset */}
                            <button
                                type="button"
                                onClick={handleResetTransform}
                                className="w-full py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 text-[10px] text-zinc-300 font-semibold transition-all"
                            >
                                Reset Transform (Origin)
                            </button>

                            {/* Material & PBR Settings */}
                            <div className="pt-2 border-t border-white/10 space-y-3">
                                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-semibold">
                                    <span>PBR MATERIAL & SHADING</span>
                                </div>

                                {/* Preset Selector */}
                                <div className="space-y-1">
                                    <label className="text-[9px] text-zinc-500">Material Preset:</label>
                                    <select
                                        value={mat.preset}
                                        onChange={(e) => handleUpdateMaterial({ preset: e.target.value })}
                                        className="w-full bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-[10px] text-zinc-200 focus:outline-none focus:border-blue-500"
                                    >
                                        {MATERIAL_PRESETS.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>

                                {/* Base Color */}
                                <div className="flex items-center justify-between gap-2">
                                    <label className="text-[10px] text-zinc-400">Base Color:</label>
                                    <div className="flex items-center gap-1.5">
                                        <input
                                            type="color"
                                            value={mat.hexColor}
                                            onChange={(e) => handleUpdateMaterial({ color: e.target.value })}
                                            className="w-5 h-5 rounded cursor-pointer bg-transparent border-none p-0"
                                        />
                                        <span className="text-[10px] text-zinc-300">{mat.hexColor.toUpperCase()}</span>
                                    </div>
                                </div>

                                {/* Roughness */}
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between text-[10px]">
                                        <span className="text-zinc-400">Roughness:</span>
                                        <span className="text-zinc-200 font-semibold">{mat.roughness.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.01"
                                        value={mat.roughness}
                                        onChange={(e) => handleUpdateMaterial({ roughness: parseFloat(e.target.value) })}
                                        className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                    />
                                </div>

                                {/* Metalness */}
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between text-[10px]">
                                        <span className="text-zinc-400">Metalness:</span>
                                        <span className="text-zinc-200 font-semibold">{mat.metalness.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.01"
                                        value={mat.metalness}
                                        onChange={(e) => handleUpdateMaterial({ metalness: parseFloat(e.target.value) })}
                                        className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                    />
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="py-12 px-4 text-center space-y-2 text-zinc-500">
                            <svg className="w-8 h-8 mx-auto stroke-zinc-600" viewBox="0 0 24 24" fill="none" strokeWidth="1.5">
                                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                            </svg>
                            <p className="text-[11px] text-zinc-400 font-semibold">No Object Selected</p>
                            <p className="text-[10px] text-zinc-600">
                                Click any mesh in the 3D viewport or select an entity from the Hierarchy tab.
                            </p>
                        </div>
                    )
                ) : (
                    /* Hierarchy Outliner Tab */
                    <div className="space-y-3">
                        {/* Search Filter */}
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search hierarchy..."
                                value={searchFilter}
                                onChange={(e) => setSearchFilter(e.target.value)}
                                className="w-full bg-black/40 border border-white/10 rounded-lg pl-7 pr-2 py-1 text-[10px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                            />
                            <svg className="w-3.5 h-3.5 absolute left-2 top-2 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                        </div>

                        {/* Quick Add Primitive */}
                        <div className="space-y-1">
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">Add Primitive</span>
                            <div className="grid grid-cols-4 gap-1">
                                {(['box', 'cylinder', 'sphere', 'torus'] as const).map(shape => (
                                    <button
                                        key={shape}
                                        type="button"
                                        onClick={() => handleAddPrimitive(shape)}
                                        className="py-1 px-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/5 text-[9px] text-zinc-300 font-semibold capitalize text-center transition-all"
                                    >
                                        +{shape}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Hierarchy List */}
                        <div className="space-y-1 pt-1">
                            <span className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">
                                Scene Graph Entities ({filteredMeshes.length})
                            </span>
                            {filteredMeshes.length === 0 ? (
                                <p className="text-[10px] text-zinc-600 italic py-2">No custom meshes found.</p>
                            ) : (
                                filteredMeshes.map(mesh => {
                                    const isSelected = mesh.id === selectedObjectId || mesh.name === selectedObjectId;
                                    const hasParent = !!mesh.parentId;
                                    return (
                                        <div
                                            key={mesh.id || mesh.name}
                                            onClick={() => onSelectObject(mesh.id || mesh.name || null)}
                                            className={`flex items-center justify-between p-1.5 rounded-lg cursor-pointer transition-all ${
                                                hasParent ? 'ml-3 border-l-2 border-blue-500/30' : ''
                                            } ${
                                                isSelected
                                                    ? 'bg-blue-600/20 border border-blue-500/50 text-blue-200'
                                                    : 'bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 text-zinc-300'
                                            }`}
                                        >
                                            <div className="flex items-center gap-1.5 truncate">
                                                <span className="text-[9px] px-1 py-0.2 rounded bg-black/40 text-zinc-400 uppercase">
                                                    {mesh.type || 'box'}
                                                </span>
                                                <span className="text-[10px] font-semibold truncate">
                                                    {mesh.name || mesh.id}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDeleteMesh(mesh.id || mesh.name || '');
                                                    }}
                                                    className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-rose-950/40 transition-all"
                                                    title="Delete mesh"
                                                >
                                                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
