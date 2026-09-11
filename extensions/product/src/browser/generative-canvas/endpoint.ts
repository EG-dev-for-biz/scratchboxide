/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface EndpointOptions {
    path: string;
}

export class Endpoint {
    constructor(protected readonly options: EndpointOptions) {}

    getRestUrl(): { toString(): string } {
        const path = this.options.path.startsWith('/') ? this.options.path : `/${this.options.path}`;
        return {
            toString: () => path
        };
    }
}
