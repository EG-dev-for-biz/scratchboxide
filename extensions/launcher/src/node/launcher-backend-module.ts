/********************************************************************************
 * Copyright (C) 2022-2024 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { ScratchboxLauncherServiceEndpoint } from './launcher-endpoint';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ScratchboxDesktopFileServiceEndpoint } from './desktopfile-endpoint';

export default new ContainerModule(bind => {
    bind(ScratchboxLauncherServiceEndpoint).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(ScratchboxLauncherServiceEndpoint);

    bind(ScratchboxDesktopFileServiceEndpoint).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(ScratchboxDesktopFileServiceEndpoint);
});
