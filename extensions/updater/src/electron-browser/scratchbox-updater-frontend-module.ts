/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ElectronMenuUpdater, ScratchboxUpdaterClientImpl, ScratchboxUpdaterFrontendContribution } from './updater/scratchbox-updater-frontend-contribution';
import { ScratchboxUpdater, ScratchboxUpdaterClient, ScratchboxUpdaterPath } from '../common/updater/scratchbox-updater';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { PreferenceContribution } from '@theia/core/lib/common';
import { scratchboxUpdaterPreferenceSchema } from './updater/scratchbox-updater-preferences';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    bind(ElectronMenuUpdater).toSelf().inSingletonScope();
    bind(ScratchboxUpdaterClientImpl).toSelf().inSingletonScope();
    bind(ScratchboxUpdaterClient).toService(ScratchboxUpdaterClientImpl);
    bind(ScratchboxUpdater).toDynamicValue(context => {
        const client = context.container.get(ScratchboxUpdaterClientImpl);
        return ElectronIpcConnectionProvider.createProxy(context.container, ScratchboxUpdaterPath, client);
    }).inSingletonScope();
    bind(ScratchboxUpdaterFrontendContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(ScratchboxUpdaterFrontendContribution);
    bind(CommandContribution).toService(ScratchboxUpdaterFrontendContribution);

    bind(PreferenceContribution).toConstantValue({ schema: scratchboxUpdaterPreferenceSchema });
});
