/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Emitter, Event, IDisposable } from '../events';

export enum SplitDirection {
    Horizontal = 'horizontal',
    Vertical = 'vertical'
}

export type DockLocation = 'left' | 'right' | 'bottom' | 'center' | 'floating';

export interface ITab {
    id: string;
    title: string;
    icon?: string;
    closeable?: boolean;
    pinned?: boolean;
    dirty?: boolean;
    data?: Record<string, any>;
}

export interface ITabGroup {
    id: string;
    tabs: ITab[];
    activeTabId?: string;
}

export interface ISplitNode {
    type: 'split';
    id: string;
    direction: SplitDirection;
    ratio: number;
    children: [LayoutNode, LayoutNode];
}

export interface ITabGroupNode {
    type: 'tab_group';
    id: string;
    group: ITabGroup;
}

export type LayoutNode = ISplitNode | ITabGroupNode;

export interface IFloatingPanel {
    id: string;
    title: string;
    position: { x: number; y: number; width: number; height: number };
    visible: boolean;
    zIndex?: number;
    data?: Record<string, any>;
}

export interface SerializedLayoutState {
    root: LayoutNode | null;
    floatingPanels: IFloatingPanel[];
}

export class WorkspaceLayoutEngine implements IDisposable {
    private _root: LayoutNode | null = null;
    private readonly _floatingPanels = new Map<string, IFloatingPanel>();

    private readonly _onDidChangeLayout = new Emitter<void>();
    private readonly _onDidActiveTabChange = new Emitter<{ groupId: string; tabId?: string }>();

    readonly onDidChangeLayout: Event<void> = this._onDidChangeLayout.event;
    readonly onDidActiveTabChange: Event<{ groupId: string; tabId?: string }> = this._onDidActiveTabChange.event;

    get root(): LayoutNode | null {
        return this._root;
    }

    createTabGroup(init?: { id?: string; activeTabId?: string; tabs?: ITab[] }): string {
        const id = init?.id || `group_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const group: ITabGroup = {
            id,
            tabs: init?.tabs ? [...init.tabs] : [],
            activeTabId: init?.activeTabId || (init?.tabs && init.tabs.length > 0 ? init.tabs[0].id : undefined)
        };

        const node: ITabGroupNode = {
            type: 'tab_group',
            id,
            group
        };

        if (!this._root) {
            this._root = node;
        }

        this._onDidChangeLayout.fire();
        return id;
    }

    private _findNode(root: LayoutNode | null, id: string): { node: LayoutNode; parent: ISplitNode | null; index: number } | null {
        if (!root) return null;
        if (root.id === id) return { node: root, parent: null, index: -1 };

        if (root.type === 'split') {
            for (let i = 0; i < 2; i++) {
                const child = root.children[i];
                if (child.id === id) {
                    return { node: child, parent: root, index: i };
                }
                const res = this._findNode(child, id);
                if (res) return res;
            }
        }
        return null;
    }

    splitGroup(
        targetGroupId: string,
        direction: SplitDirection,
        options?: { ratio?: number; initialTabs?: ITab[] }
    ): string {
        const targetEntry = this._findNode(this._root, targetGroupId);
        if (!targetEntry || targetEntry.node.type !== 'tab_group') {
            throw new Error(`Target tab group not found: ${targetGroupId}`);
        }

        const newGroupId = `group_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const newGroup: ITabGroup = {
            id: newGroupId,
            tabs: options?.initialTabs ? [...options.initialTabs] : [],
            activeTabId: options?.initialTabs && options.initialTabs.length > 0 ? options.initialTabs[0].id : undefined
        };

        const newNode: ITabGroupNode = {
            type: 'tab_group',
            id: newGroupId,
            group: newGroup
        };

        const splitNode: ISplitNode = {
            type: 'split',
            id: `split_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            direction,
            ratio: options?.ratio ?? 0.5,
            children: [targetEntry.node, newNode]
        };

        if (targetEntry.parent === null) {
            this._root = splitNode;
        } else {
            targetEntry.parent.children[targetEntry.index] = splitNode;
        }

        this._onDidChangeLayout.fire();
        return newGroupId;
    }

    addTab(groupId: string, tab: ITab, activate: boolean = true): void {
        const entry = this._findNode(this._root, groupId);
        if (!entry || entry.node.type !== 'tab_group') {
            throw new Error(`Tab group not found: ${groupId}`);
        }

        const group = entry.node.group;
        const exists = group.tabs.some(t => t.id === tab.id);
        if (!exists) {
            group.tabs.push(tab);
        }

        if (activate || !group.activeTabId) {
            group.activeTabId = tab.id;
            this._onDidActiveTabChange.fire({ groupId, tabId: tab.id });
        }

        this._onDidChangeLayout.fire();
    }

    removeTab(groupId: string, tabId: string): void {
        const entry = this._findNode(this._root, groupId);
        if (!entry || entry.node.type !== 'tab_group') {
            return;
        }

        const group = entry.node.group;
        const idx = group.tabs.findIndex(t => t.id === tabId);
        if (idx !== -1) {
            group.tabs.splice(idx, 1);
            if (group.activeTabId === tabId) {
                group.activeTabId = group.tabs.length > 0 ? group.tabs[Math.max(0, idx - 1)].id : undefined;
                this._onDidActiveTabChange.fire({ groupId, tabId: group.activeTabId });
            }
            this._onDidChangeLayout.fire();
        }
    }

    moveTab(tabId: string, fromGroupId: string, toGroupId: string, targetIndex?: number): void {
        const fromEntry = this._findNode(this._root, fromGroupId);
        const toEntry = this._findNode(this._root, toGroupId);

        if (!fromEntry || fromEntry.node.type !== 'tab_group' || !toEntry || toEntry.node.type !== 'tab_group') {
            throw new Error('Source or target tab group not found');
        }

        const fromGroup = fromEntry.node.group;
        const toGroup = toEntry.node.group;

        const tabIdx = fromGroup.tabs.findIndex(t => t.id === tabId);
        if (tabIdx === -1) {
            return;
        }

        const [tab] = fromGroup.tabs.splice(tabIdx, 1);
        if (fromGroup.activeTabId === tabId) {
            fromGroup.activeTabId = fromGroup.tabs.length > 0 ? fromGroup.tabs[Math.max(0, tabIdx - 1)].id : undefined;
            this._onDidActiveTabChange.fire({ groupId: fromGroupId, tabId: fromGroup.activeTabId });
        }

        if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= toGroup.tabs.length) {
            toGroup.tabs.splice(targetIndex, 0, tab);
        } else {
            toGroup.tabs.push(tab);
        }

        toGroup.activeTabId = tab.id;
        this._onDidActiveTabChange.fire({ groupId: toGroupId, tabId: tab.id });

        this._onDidChangeLayout.fire();
    }

    setActiveTab(groupId: string, tabId: string): void {
        const entry = this._findNode(this._root, groupId);
        if (!entry || entry.node.type !== 'tab_group') {
            return;
        }

        const group = entry.node.group;
        if (group.tabs.some(t => t.id === tabId)) {
            group.activeTabId = tabId;
            this._onDidActiveTabChange.fire({ groupId, tabId });
            this._onDidChangeLayout.fire();
        }
    }

    getActiveTab(groupId: string): ITab | undefined {
        const entry = this._findNode(this._root, groupId);
        if (!entry || entry.node.type !== 'tab_group') {
            return undefined;
        }
        const group = entry.node.group;
        return group.tabs.find(t => t.id === group.activeTabId);
    }

    getTabsInGroup(groupId: string): ITab[] {
        const entry = this._findNode(this._root, groupId);
        if (!entry || entry.node.type !== 'tab_group') {
            return [];
        }
        return [...entry.node.group.tabs];
    }

    getAllTabGroups(): ITabGroup[] {
        const groups: ITabGroup[] = [];
        const traverse = (node: LayoutNode | null) => {
            if (!node) return;
            if (node.type === 'tab_group') {
                groups.push(node.group);
            } else if (node.type === 'split') {
                traverse(node.children[0]);
                traverse(node.children[1]);
            }
        };
        traverse(this._root);
        return groups;
    }

    // Floating Panel Management
    openFloatingPanel(panel: IFloatingPanel): string {
        this._floatingPanels.set(panel.id, { ...panel });
        this._onDidChangeLayout.fire();
        return panel.id;
    }

    getFloatingPanel(panelId: string): IFloatingPanel | undefined {
        return this._floatingPanels.get(panelId);
    }

    getAllFloatingPanels(): IFloatingPanel[] {
        return Array.from(this._floatingPanels.values());
    }

    setFloatingPanelVisibility(panelId: string, visible: boolean): void {
        const panel = this._floatingPanels.get(panelId);
        if (panel && panel.visible !== visible) {
            panel.visible = visible;
            this._onDidChangeLayout.fire();
        }
    }

    setFloatingPanelPosition(panelId: string, position: { x: number; y: number; width: number; height: number }): void {
        const panel = this._floatingPanels.get(panelId);
        if (panel) {
            panel.position = { ...position };
            this._onDidChangeLayout.fire();
        }
    }

    closeFloatingPanel(panelId: string): void {
        if (this._floatingPanels.delete(panelId)) {
            this._onDidChangeLayout.fire();
        }
    }

    // Serialization
    serialize(): string {
        const state: SerializedLayoutState = {
            root: this._root,
            floatingPanels: this.getAllFloatingPanels()
        };
        return JSON.stringify(state, null, 2);
    }

    static deserialize(json: string): WorkspaceLayoutEngine {
        const engine = new WorkspaceLayoutEngine();
        try {
            const parsed: SerializedLayoutState = JSON.parse(json);
            engine._root = parsed.root;
            if (parsed.floatingPanels) {
                for (const p of parsed.floatingPanels) {
                    engine._floatingPanels.set(p.id, p);
                }
            }
        } catch (err) {
            console.error('Failed to deserialize layout state:', err);
        }
        return engine;
    }

    dispose(): void {
        this._root = null;
        this._floatingPanels.clear();
        this._onDidChangeLayout.dispose();
        this._onDidActiveTabChange.dispose();
    }
}
