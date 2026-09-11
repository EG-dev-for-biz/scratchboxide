/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { JsonRpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const ScratchboxUpdaterPath = '/services/scratchbox-updater';
export const ScratchboxUpdater = Symbol('ScratchboxUpdater');
export interface ScratchboxUpdater extends JsonRpcServer<ScratchboxUpdaterClient> {
    checkForUpdates(): void;
    downloadUpdate(): void;
    onRestartToUpdateRequested(): void;
    disconnectClient(client: ScratchboxUpdaterClient): void;
    setUpdateChannel(channel: string): void;
    cancel(): void;
}

export const ScratchboxUpdaterClient = Symbol('ScratchboxUpdaterClient');

export interface UpdaterError {
    message: string;
    errorLogPath?: string;
}

export interface UpdateInfo {
    version: string;
}

export interface UpdateAvailabilityInfo {
    available: boolean;
    updateInfo?: UpdateInfo;
}

export interface ScratchboxUpdaterClient {
    updateAvailable(available: boolean, startupCheck: boolean, updateInfo?: UpdateInfo): void;
    notifyReadyToInstall(): void;
    reportError(error: UpdaterError): void;
    reportCancelled(): void;
}
