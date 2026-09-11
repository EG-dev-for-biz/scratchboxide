/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ScratchboxUpdater, ScratchboxUpdaterClient, ScratchboxUpdaterPath } from '../../common/updater/scratchbox-updater';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ScratchboxUpdaterImpl } from './scratchbox-updater-impl';

export default new ContainerModule(bind => {
    bind(ScratchboxUpdaterImpl).toSelf().inSingletonScope();
    bind(ScratchboxUpdater).toService(ScratchboxUpdaterImpl);
    bind(ElectronMainApplicationContribution).toService(ScratchboxUpdater);
    bind(ElectronConnectionHandler).toDynamicValue(context =>
        new JsonRpcConnectionHandler<ScratchboxUpdaterClient>(ScratchboxUpdaterPath, client => {
            const server = context.container.get<ScratchboxUpdater>(ScratchboxUpdater);
            server.setClient(client);
            client.onDidCloseConnection(() => server.disconnectClient(client));
            return server;
        })
    ).inSingletonScope();
});
