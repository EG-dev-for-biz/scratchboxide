/********************************************************************************
 * Copyright (C) 2020 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { WindowService } from '@theia/core/lib/browser/window/window-service';
import * as React from 'react';

export function renderFeaturesBento(windowService: WindowService): React.ReactNode {
    return <div className='sb-bento-grid'>
        <div className='sb-card'>
            <h4 className='sb-card-title'>Modern &amp; Extensible</h4>
            <p className='sb-card-desc'>
                Extend Scratchbox IDE with compatible extensions and custom toolchains tailored to your workflow.
            </p>
        </div>

        <div className='sb-card'>
            <h4 className='sb-card-title'>Real-Time Collaboration</h4>
            <p className='sb-card-desc'>
                Share workspaces and collaborate live with your team directly inside the editor.
            </p>
        </div>

        <div className='sb-card'>
            <h4 className='sb-card-title'>Private &amp; Offline Ready</h4>
            <p className='sb-card-desc'>
                Completely self-contained environment with zero external telemetry or cloud tracking.
            </p>
        </div>

        <div className='sb-card'>
            <h4 className='sb-card-title'>Professional Tooling</h4>
            <p className='sb-card-desc'>
                Integrated terminal, advanced debugging, Monaco editor, and full Git source control.
            </p>
        </div>
    </div>;
}
