/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import '../../src/browser/style/index.css';

import { WidgetFactory } from '@theia/core/lib/browser';
import { AboutDialog, AboutDialogProps } from '@theia/core/lib/browser/about-dialog';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { ScratchboxIDEAboutDialog } from './scratchbox-ide-about-dialog';
import { ScratchboxIDEContribution } from './scratchbox-ide-contribution';
import { ScratchboxIDEGettingStartedWidget } from './scratchbox-ide-getting-started-widget';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    bind(ScratchboxIDEGettingStartedWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GettingStartedWidget.ID,
        createWidget: () => context.container.get<ScratchboxIDEGettingStartedWidget>(ScratchboxIDEGettingStartedWidget),
    })).inSingletonScope();

    if (isBound(AboutDialogProps)) {
        rebind(AboutDialogProps).toConstantValue({ title: 'About Scratchbox IDE' });
    } else {
        bind(AboutDialogProps).toConstantValue({ title: 'About Scratchbox IDE' });
    }

    if (isBound(AboutDialog)) {
        rebind(AboutDialog).to(ScratchboxIDEAboutDialog).inSingletonScope();
    } else {
        bind(AboutDialog).to(ScratchboxIDEAboutDialog).inSingletonScope();
    }

    bind(ScratchboxIDEContribution).toSelf().inSingletonScope();
    [CommandContribution, MenuContribution].forEach(serviceIdentifier =>
        bind(serviceIdentifier).toService(ScratchboxIDEContribution)
    );
});
