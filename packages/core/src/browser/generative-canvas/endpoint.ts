/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
