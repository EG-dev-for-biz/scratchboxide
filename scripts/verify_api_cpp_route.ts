/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Verification Script: Operate the Scratchbox Standalone Backend Express API
 * to compile and execute a native C++ application via HTTP route.
 ********************************************************************************/

import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { createCppRouter } from '../desktop-app/server/routes/cppRoutes';
import { NativeCppCompilerService } from '../packages/core/src/node';

async function main() {
    console.log('================================================================');
    console.log('🌐 OPERATING SCRATCHBOX BACKEND API ROUTE: /api/cpp/compile');
    console.log('================================================================\n');

    const compiler = NativeCppCompilerService.getInstance();
    const router = createCppRouter(compiler, {
        broadcast: () => {},
        sendError: (res, err, status = 500) => res.status(status).json({ error: String(err) })
    });

    const cppAppSource = `
#include <iostream>
#include <vector>
#include <numeric>

int main(int argc, char** argv) {
    std::cout << "[Scratchbox HTTP API Engine] Executable application compiled and running via Express router!" << std::endl;
    
    std::vector<int> numbers = {10, 20, 30, 40, 50};
    int sum = std::accumulate(numbers.begin(), numbers.end(), 0);
    std::cout << "[Scratchbox HTTP API Engine] Computed Vector Sum: " << sum << std::endl;
    std::cout << "[Scratchbox HTTP API Engine] Execution status: SUCCESS (Code 0)" << std::endl;
    return 0;
}
`;

    console.log('1. Dispatching request to createCppRouter POST /compile...');
    
    const responsePromise = new Promise<{ status: number; data: any }>((resolve) => {
        const req: any = {
            body: {
                sourceCode: cppAppSource,
                optimization: '-O3'
            }
        };

        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(data: any) {
                resolve({ status: this.statusCode, data });
                return this;
            }
        };

        // Find the POST /compile handler in the router stack
        const routeLayer = router.stack.find((layer: any) => layer.route?.path === '/compile' && layer.route?.methods?.post);
        if (!routeLayer) {
            throw new Error('Route /compile not found in C++ router stack');
        }

        const handler = routeLayer.route.stack[0].handle;
        handler(req, res);
    });

    const response = await responsePromise;
    console.log(`2. Response Status: ${response.status}`);
    console.log('3. Response Data:', JSON.stringify({
        success: response.data?.success,
        exitCode: response.data?.exitCode,
        compilationTimeMs: response.data?.compilationTimeMs,
        executionTimeMs: response.data?.executionTimeMs,
        stdout: response.data?.stdout
    }, null, 2));

    if (response.status === 200 && response.data?.success === true) {
        console.log('\n  ✓ Verified: App backend accepted code, compiled binary, executed it, and returned stdout:');
        console.log('    >>', response.data.stdout?.trim());
        console.log(`    Compilation time: ${response.data.compilationTimeMs}ms`);
        console.log(`    Execution time:   ${response.data.executionTimeMs}ms`);
        console.log('\n🎉 Standalone Server API Route operation verified successfully!');
    } else {
        console.error('❌ Server API Route operation failed:', response.data);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('API Verification error:', err);
    process.exit(1);
});
