/********************************************************************************
 * Copyright (C) 2020 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { AboutDialog, AboutDialogProps, ABOUT_CONTENT_CLASS } from '@theia/core/lib/browser/about-dialog';
import { injectable, inject } from '@theia/core/shared/inversify';
import { VSXEnvironment } from '@theia/vsx-registry/lib/common/vsx-environment';
import { WindowService } from '@theia/core/lib/browser/window/window-service';

@injectable()
export class ScratchboxIDEAboutDialog extends AboutDialog {

    @inject(VSXEnvironment)
    protected readonly environment: VSXEnvironment;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    protected vscodeApiVersion: string;

    constructor(
        @inject(AboutDialogProps) protected readonly props: AboutDialogProps
    ) {
        super(props);
    }

    protected async doInit(): Promise<void> {
        this.vscodeApiVersion = await this.environment.getVscodeApiVersion();
        super.doInit();
    }

    protected render(): React.ReactNode {
        return <div className={ABOUT_CONTENT_CLASS}>
            {this.renderContent()}
        </div>;
    }

    protected renderContent(): React.ReactNode {
        return <div className='sb-about-container'>
            <div className='sb-about-header'>
                <div className='sb-about-logo'></div>
                <div className='sb-about-badges'>
                    <span className='sb-badge'>Version {this.applicationInfo ? this.applicationInfo.version : '1.67.100'}</span>
                    <span className='sb-badge'>VS Code API {this.vscodeApiVersion || '1.106.1'}</span>
                </div>
                <p className='sb-about-description'>
                    Scratchbox — A canvas for AI work. Built with modern high-performance tooling for cloud, local and canvas workflows.
                </p>
                <div className='sb-about-links-row' style={{ marginTop: '8px', fontSize: '12px' }}>
                    <a href='https://www.scratchbox.ai' target='_blank' rel='noreferrer' style={{ color: 'var(--sb-system-blue)', textDecoration: 'none' }}>
                        www.scratchbox.ai
                    </a>
                </div>
            </div>

            <div className='sb-about-extensions-section'>
                <h4 className='sb-about-section-title'>Included Extensions &amp; Modules</h4>
                <div className='sb-about-extensions-wrapper'>
                    {this.renderExtensions()}
                </div>
            </div>

            <div className='sb-about-footer'>
                <p>Copyright &copy; 2026 Scratchbox. Released under the MIT License.</p>
            </div>
        </div>;
    }
}
