/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ScratchboxUpdater, ScratchboxUpdaterClient } from '../../common/updater/scratchbox-updater';
import { injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from 'builder-util-runtime';

const { autoUpdater } = require('electron-updater');

autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

@injectable()
export class ScratchboxUpdaterImpl implements ScratchboxUpdater, ElectronMainApplicationContribution {

    protected clients: Array<ScratchboxUpdaterClient> = [];

    private initialCheck: boolean = true;
    private updateChannelReported: boolean = false;
    private reportOnFirstRegistration: boolean = false;
    private cancellationToken: CancellationToken = new CancellationToken();

    constructor() {
        autoUpdater.autoDownload = false;
        autoUpdater.on('update-available', (info: { version: string }) => {
            if (this.updateChannelReported) {
                const startupCheck = this.initialCheck;
                if (this.initialCheck) {
                    this.initialCheck = false;
                    if (this.clients.length === 0) {
                        this.reportOnFirstRegistration = true;
                    }
                }
                const updateInfo = { version: info.version };
                this.clients.forEach(c => c.updateAvailable(true, startupCheck, updateInfo));
            }
        });
        autoUpdater.on('update-not-available', () => {
            if (this.updateChannelReported) {
                if (this.initialCheck) {
                    this.initialCheck = false;
                    /* do not report that no update is available on start up */
                    return;
                }
                this.clients.forEach(c => c.updateAvailable(false, false));
            }
        });

        autoUpdater.on('update-downloaded', () => {
            this.clients.forEach(c => c.notifyReadyToInstall());
        });

        autoUpdater.on('error', (err: unknown) => {
            if (err instanceof Error && err.message.includes('cancelled')) {
                return;
            }
            const errorLogPath = autoUpdater.logger.transports.file.getFile().path;
            this.clients.forEach(c => c.reportError({ message: 'An error has occurred while attempting to update.', errorLogPath }));
        });
    }

    checkForUpdates(): void {
        autoUpdater.logger.info('Check for updates requested, but external updates are disabled.');
    }

    onRestartToUpdateRequested(): void {
        autoUpdater.quitAndInstall();
    }

    cancel(): void {
        autoUpdater.logger.info('Update cancelled by user');
        this.cancellationToken.cancel();
        this.clients.forEach(c => c.reportCancelled());
    }

    downloadUpdate(): void {
        autoUpdater.logger.info('Downloading update');
        this.cancellationToken = new CancellationToken();
        autoUpdater.downloadUpdate(this.cancellationToken);
    }

    onStart(application: ElectronMainApplication): void {
        // Called when the contribution is starting. You can use both async and sync code from here.
    }

    onStop(application: ElectronMainApplication): void {
        // Invoked when the contribution is stopping. You can clean up things here. You are not allowed call async code from here.
    }

    setClient(client: ScratchboxUpdaterClient | undefined): void {
        if (client) {
            this.clients.push(client);
            if (this.reportOnFirstRegistration) {
                this.reportOnFirstRegistration = false;
                this.clients.forEach(c => c.updateAvailable(true, true));
            }
        }
    }

    setUpdateChannel(channel: string): void {
        const feedURL = this.getFeedURL(channel);
        autoUpdater.setFeedURL(feedURL);
        if (!this.updateChannelReported) {
            this.updateChannelReported = true;
            this.checkForUpdates();
        }
    }

    protected getFeedURL(channel: string): string {
        return '';
    }

    disconnectClient(client: ScratchboxUpdaterClient): void {
        const index = this.clients.indexOf(client);
        if (index !== -1) {
            this.clients.splice(index, 1);
        }
    }

    dispose(): void {
        this.clients.forEach(this.disconnectClient.bind(this));
    }

}
