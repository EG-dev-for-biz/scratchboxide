/********************************************************************************
 * Copyright (C) 2021 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-frontend-contribution';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry, MenuPath } from '@theia/core/lib/common/menu';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';

export namespace ScratchboxIDEMenus {
    export const SCRATCHBOX_IDE_HELP: MenuPath = [...CommonMenus.HELP, 'scratchbox-ide'];
}

export namespace ScratchboxIDECommands {
    export const CATEGORY = 'ScratchboxIDE';
    export const OPEN_CANVAS_STUDIO: Command = {
        id: 'scratchbox-ide:open-canvas-studio',
        category: CATEGORY,
        label: 'Open AI Canvas Studio'
    };
    export const REPORT_ISSUE: Command = {
        id: 'scratchbox-ide:report-issue',
        category: CATEGORY,
        label: 'Report Issue'
    };
    export const DOCUMENTATION: Command = {
        id: 'scratchbox-ide:documentation',
        category: CATEGORY,
        label: 'Documentation'
    };
}

@injectable()
export class ScratchboxIDEContribution implements CommandContribution, MenuContribution {

    @inject(WindowService)
    protected readonly windowService: WindowService;

    static REPORT_ISSUE_URL = 'https://scratchbox.io/issues';
    static DOCUMENTATION_URL = 'https://scratchbox.io/docs';

    registerCommands(commandRegistry: CommandRegistry): void {
        commandRegistry.registerCommand(ScratchboxIDECommands.OPEN_CANVAS_STUDIO, {
            execute: () => commandRegistry.executeCommand(GettingStartedWidget.ID)
        });
        commandRegistry.registerCommand(ScratchboxIDECommands.REPORT_ISSUE, {
            execute: () => this.windowService.openNewWindow(ScratchboxIDEContribution.REPORT_ISSUE_URL, { external: true })
        });
        commandRegistry.registerCommand(ScratchboxIDECommands.DOCUMENTATION, {
            execute: () => this.windowService.openNewWindow(ScratchboxIDEContribution.DOCUMENTATION_URL, { external: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(ScratchboxIDEMenus.SCRATCHBOX_IDE_HELP, {
            commandId: ScratchboxIDECommands.OPEN_CANVAS_STUDIO.id,
            label: ScratchboxIDECommands.OPEN_CANVAS_STUDIO.label,
            order: '0'
        });
        menus.registerMenuAction(ScratchboxIDEMenus.SCRATCHBOX_IDE_HELP, {
            commandId: ScratchboxIDECommands.REPORT_ISSUE.id,
            label: ScratchboxIDECommands.REPORT_ISSUE.label,
            order: '1'
        });
        menus.registerMenuAction(ScratchboxIDEMenus.SCRATCHBOX_IDE_HELP, {
            commandId: ScratchboxIDECommands.DOCUMENTATION.id,
            label: ScratchboxIDECommands.DOCUMENTATION.label,
            order: '2'
        });
    }
}
