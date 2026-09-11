/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';

import { Message } from '@theia/core/lib/browser';
import { PreferenceService } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GenerativeCanvasStudio } from './generative-canvas/GenerativeCanvasStudio';

import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';
import { VSXEnvironment } from '@theia/vsx-registry/lib/common/vsx-environment';
import { WindowService } from '@theia/core/lib/browser/window/window-service';

@injectable()
export class ScratchboxIDEGettingStartedWidget extends GettingStartedWidget {

    @inject(VSXEnvironment)
    protected readonly environment: VSXEnvironment;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    protected vscodeApiVersion: string;

    protected override async doInit(): Promise<void> {
        await super.doInit();
        this.vscodeApiVersion = await this.environment.getVscodeApiVersion();
        await this.preferenceService.ready;
        this.applyStudioModeClass();
        this.toDispose.push({
            dispose: () => {
                if (typeof document !== 'undefined') {
                    document.body.classList.remove('sb-studio-mode');
                }
            }
        });
        this.update();
    }

    protected applyStudioModeClass(): void {
        if (typeof document !== 'undefined') {
            document.body.classList.add('sb-studio-mode');
            document.body.classList.remove('sb-ide-mode');
        }
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.applyStudioModeClass();
    }

    protected render(): React.ReactNode {
        return (
            <div className='sb-welcome-container sb-consumer-studio-mode sb-canvas-full-viewport'>
                <div className='sb-welcome-content sb-canvas-full-content'>
                    <div className='sb-canvas-studio-view'>
                        <GenerativeCanvasStudio
                            onOpenFolder={() => this.doOpenFolder()}
                            onCreateFile={() => this.doCreateFile()}
                            onOpenWorkspace={() => this.doOpenWorkspace()}
                            onOpenPreferences={() => this.doOpenPreferences()}
                            onOpenKeyboardShortcuts={() => this.doOpenKeyboardShortcuts()}
                            onExecuteCommand={cmdId => this.commandRegistry.executeCommand(cmdId)}
                        />
                    </div>
                </div>
            </div>
        );
    }
}
