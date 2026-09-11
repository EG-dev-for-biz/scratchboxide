/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import { Container } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common';
import backendModule from '../src/node/scratchbox-gemini-backend-module';
import { GeminiEndpoint } from '../src/node/gemini-endpoint';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaGenerationJobService } from '../src/node/media-generation-job-service';

function runMediaBackendModuleTests(): void {
    console.log('🧪 Running media backend module binding tests...');

    const container = new Container();
    container.load(backendModule);
    container.bind(ILogger).toConstantValue({} as ILogger);

    const generator = container.get(GoogleMediaGenerationService);
    assert.ok(generator instanceof GoogleMediaGenerationService);
    assert.strictEqual(
        container.get(GoogleMediaGenerationService),
        generator,
        'Google media generator must have singleton lifecycle'
    );

    const jobs = container.get(MediaGenerationJobService);
    assert.ok(jobs instanceof MediaGenerationJobService);
    assert.strictEqual(
        (jobs as any).generator,
        generator,
        'Media jobs must resolve the bound singleton generator'
    );

    const endpoint = container.get(GeminiEndpoint);
    assert.ok(endpoint instanceof GeminiEndpoint);

    console.log('🎉 MEDIA BACKEND MODULE BINDING TESTS PASSED');
}

runMediaBackendModuleTests();
