/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { Emitter, Event, IDisposable, toDisposable } from '../events';
import { ICommandRegistry } from './commands';
import { IContextKeyService } from './contextkey';

export type MenuId = string;

export interface IMenuItem {
    command: string;
    label?: string;
    icon?: string;
    when?: string;
    group?: string;
    order?: number;
    submenu?: MenuId;
    disabled?: boolean;
}

export class MenuRegistry implements IDisposable {
    private readonly _menus = new Map<MenuId, IMenuItem[]>();
    private readonly _onDidRegisterMenuItem = new Emitter<{ menuId: MenuId; item: IMenuItem }>();

    readonly onDidRegisterMenuItem: Event<{ menuId: MenuId; item: IMenuItem }> = this._onDidRegisterMenuItem.event;

    get commandRegistry(): ICommandRegistry | undefined {
        return this._commandRegistry;
    }

    get contextKeyService(): IContextKeyService | undefined {
        return this._contextKeyService;
    }

    constructor(
        private readonly _commandRegistry?: ICommandRegistry,
        private readonly _contextKeyService?: IContextKeyService
    ) {}

    registerMenuItem(menuId: MenuId, item: IMenuItem): IDisposable {
        let items = this._menus.get(menuId);
        if (!items) {
            items = [];
            this._menus.set(menuId, items);
        }
        items.push(item);
        this._onDidRegisterMenuItem.fire({ menuId, item });

        return toDisposable(() => {
            const list = this._menus.get(menuId);
            if (list) {
                const idx = list.indexOf(item);
                if (idx !== -1) {
                    list.splice(idx, 1);
                }
            }
        });
    }

    getMenuItems(menuId: MenuId): IMenuItem[] {
        const rawItems = this._menus.get(menuId) || [];
        
        // Filter by context if `when` is set
        const visibleItems = rawItems.filter(item => {
            if (this._contextKeyService && item.when) {
                return this._contextKeyService.evaluate(item.when);
            }
            return true;
        });

        // Sort by group, then by order
        return [...visibleItems].sort((a, b) => {
            const groupA = a.group || '0_default';
            const groupB = b.group || '0_default';
            if (groupA !== groupB) {
                return groupA.localeCompare(groupB);
            }
            const orderA = a.order ?? 0;
            const orderB = b.order ?? 0;
            return orderA - orderB;
        });
    }

    dispose(): void {
        this._onDidRegisterMenuItem.dispose();
        this._menus.clear();
    }
}
