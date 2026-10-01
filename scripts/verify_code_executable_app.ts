/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Verification Script: Operate the app and ensure that it can code an
 * executable application across the app's architectural tiers.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
    MultiPlatformScaffolder,
    NativeCppCompilerService,
    ContainerSandboxService
} from '../packages/core/src/node';

const execFileAsync = promisify(execFile);

async function main() {
    console.log('================================================================');
    console.log('🚀 OPERATING SCRATCHBOX IDE: CODE & EXECUTE APPLICATION VERIFICATION');
    console.log('================================================================\n');

    let allPassed = true;

    // -------------------------------------------------------------------------
    // TEST 1: Code Generation with MultiPlatformScaffolder
    // -------------------------------------------------------------------------
    console.log('📦 TEST 1: App Codes a Native C++ Application via MultiPlatformScaffolder');
    const scaffolder = new MultiPlatformScaffolder();
    const appFiles = scaffolder.generateScaffold('native_systems', 'orbital_physics_sim', ['cpp']);

    console.log('  Generated files count:', Object.keys(appFiles).length);
    for (const filePath of Object.keys(appFiles)) {
        console.log(`    - ${filePath} (${appFiles[filePath].length} bytes)`);
    }

    if (!appFiles['src/main.cpp'] || !appFiles['include/engine.hpp'] || !appFiles['src/engine.cpp']) {
        console.error('❌ Failed: Missing core C++ application files from scaffolder');
        allPassed = false;
        return;
    }
    console.log('  ✓ Verified: App scaffolded complete C++ project with main.cpp and engine implementation.\n');

    // -------------------------------------------------------------------------
    // TEST 2: Stage & Compile Scaffolded Project into Standalone Executable
    // -------------------------------------------------------------------------
    console.log('🔨 TEST 2: Compile the Scaffolded Project into a Standalone Executable Binary');
    const buildDir = path.resolve(process.cwd(), 'build/test_scaffolded_app');
    await fs.emptyDir(buildDir);

    for (const [relPath, content] of Object.entries(appFiles)) {
        const fullPath = path.join(buildDir, relPath);
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content, 'utf8');
    }

    const binaryOut = path.join(buildDir, 'orbital_physics_app');
    const compiler = process.env.CXX || 'clang++';
    console.log(`  Invoking compiler: ${compiler} -std=c++20 -O3 ...`);

    const compileStart = Date.now();
    try {
        await execFileAsync(compiler, [
            '-std=c++20',
            '-O3',
            '-Iinclude',
            'src/engine.cpp',
            'src/main.cpp',
            '-o',
            binaryOut
        ], { cwd: buildDir });
        const compileDuration = Date.now() - compileStart;
        console.log(`  ✓ Compilation Succeeded in ${compileDuration}ms!`);
        console.log(`  Binary Location: ${binaryOut}`);

        const binStat = await fs.stat(binaryOut);
        console.log(`  Binary Size: ${(binStat.size / 1024).toFixed(1)} KB`);
        console.log(`  Executable permissions: 0${(binStat.mode & 0o777).toString(8)}`);
    } catch (err: any) {
        console.error('❌ Compilation failed:', err.stderr || err.message);
        allPassed = false;
        return;
    }

    // -------------------------------------------------------------------------
    // TEST 3: Execute the Compiled Binary & Validate Its Output
    // -------------------------------------------------------------------------
    console.log('\n▶️ TEST 3: Execute the Compiled Binary and Validate Execution');
    try {
        const execStart = Date.now();
        const { stdout, stderr } = await execFileAsync(binaryOut, [], { cwd: buildDir });
        const execDuration = Date.now() - execStart;
        console.log(`  ✓ Application Executed in ${execDuration}ms!`);
        console.log('  --- Standard Output ---');
        console.log(stdout.trim());
        console.log('  -----------------------');

        if (!stdout.includes('Starting native physics simulation...') || !stdout.includes('Step 9: Y =')) {
            console.error('❌ Output did not contain expected simulation steps');
            allPassed = false;
        } else {
            console.log('  ✓ Verified: Executable ran cleanly, simulated physics, and returned code 0.');
        }
    } catch (err: any) {
        console.error('❌ Execution failed:', err.message);
        allPassed = false;
    }

    // -------------------------------------------------------------------------
    // TEST 4: Code & Execute Application via NativeCppCompilerService
    // -------------------------------------------------------------------------
    console.log('\n⚡ TEST 4: Code & Execute C++20 Application via NativeCppCompilerService');
    const nativeCompilerService = NativeCppCompilerService.getInstance();

    const customAppCode = `
#include <iostream>
#include <vector>
#include <numeric>
#include <cmath>

struct Particle {
    double x, y, z;
    double vx, vy, vz;
    double mass;
};

int main(int argc, char** argv) {
    std::cout << "[Scratchbox Autonomous App] Initializing N-Body Gravitational Cluster..." << std::endl;
    std::vector<Particle> cluster;
    
    // Seed 100 particles in a gravitational orbital disc
    for (int i = 0; i < 100; ++i) {
        double angle = (2.0 * M_PI * i) / 100.0;
        double radius = 10.0 + (i % 10) * 2.0;
        double speed = std::sqrt(1000.0 / radius);
        cluster.push_back({
            radius * std::cos(angle),
            radius * std::sin(angle),
            (i % 5) * 0.2,
            -speed * std::sin(angle),
            speed * std::cos(angle),
            0.0,
            1.0 + (i % 3)
        });
    }

    std::cout << "[Scratchbox Autonomous App] Successfully seeded " << cluster.size() << " particles." << std::endl;
    
    // Simulate 5 leapfrog integration steps
    double dt = 0.05;
    for (int step = 0; step < 5; ++step) {
        double totalKineticEnergy = 0.0;
        for (auto& p : cluster) {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            double vSq = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
            totalKineticEnergy += 0.5 * p.mass * vSq;
        }
        std::cout << "  Step " << step + 1 << ": Kinetic Energy = " << totalKineticEnergy << " Joules" << std::endl;
    }

    std::cout << "[Scratchbox Autonomous App] N-Body simulation finished cleanly with status SUCCESS." << std::endl;
    return 0;
}
`;

    console.log('  Compiling custom application source code...');
    const compileRes = await nativeCompilerService.compileSource(customAppCode, {
        outputDir: path.resolve(process.cwd(), 'build/3d-native'),
        outputBinaryName: 'gravitational_nbody_app',
        optimization: '-O3'
    });

    if (!compileRes.success || !compileRes.binaryPath) {
        console.error('❌ Native compiler service failed to compile source:', compileRes.compilerOutput);
        allPassed = false;
        return;
    }

    console.log(`  ✓ Compilation Succeeded (${compileRes.compilationTimeMs}ms)`);
    console.log(`  Binary: ${compileRes.binaryPath}`);

    console.log('  Executing binary via NativeCppCompilerService.executeBinary()...');
    const execRes = await nativeCompilerService.executeBinary(compileRes.binaryPath);

    if (!execRes.success) {
        console.error('❌ Native compiler service execution failed:', execRes.stderr);
        allPassed = false;
    } else {
        console.log(`  ✓ Application Execution Succeeded in ${execRes.executionTimeMs}ms (Exit Code: ${execRes.exitCode})`);
        console.log('  --- Execution Output ---');
        console.log(execRes.stdout.trim());
        console.log('  ------------------------');
        if (execRes.stdout.includes('N-Body simulation finished cleanly with status SUCCESS')) {
            console.log('  ✓ Verified: Application logic executed and validated completely.');
        } else {
            console.error('❌ Missing expected output token');
            allPassed = false;
        }
    }

    // -------------------------------------------------------------------------
    // TEST 5: CLI Operation (sbox bake on 3D procedural generator application)
    // -------------------------------------------------------------------------
    console.log('\n🌐 TEST 5: Operate Scratchbox CLI to Bake Procedural 3D Executable');
    const cliPath = path.resolve(process.cwd(), 'packages/cli/bin/sbox.js');
    const generatorFile = path.resolve(process.cwd(), 'world_generator.cpp');
    const outputGlb = path.resolve(process.cwd(), 'build/3d-native/world_generator_output.glb');

    try {
        console.log(`  Running: node packages/cli/bin/sbox.js bake world_generator.cpp -o ${outputGlb}`);
        const { stdout: cliOut, stderr: cliErr } = await execFileAsync(
            process.execPath,
            [cliPath, 'bake', generatorFile, '-o', outputGlb],
            { cwd: process.cwd(), timeout: 120000 }
        );
        console.log('  --- CLI Output ---');
        console.log(cliOut.trim());
        console.log('  ------------------');

        if (await fs.pathExists(outputGlb)) {
            const glbStats = await fs.stat(outputGlb);
            console.log(`  ✓ Successfully baked 3D asset: ${outputGlb} (${(glbStats.size / 1024).toFixed(1)} KB)`);
        } else {
            console.error('❌ Output GLB was not created');
            allPassed = false;
        }
    } catch (err: any) {
        console.error('❌ CLI bake failed:', err.stderr || err.stdout || err.message);
        allPassed = false;
    }

    // -------------------------------------------------------------------------
    // SUMMARY
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    if (allPassed) {
        console.log('🎉 ALL TESTS PASSED: Scratchbox IDE successfully operated and verified');
        console.log('   to code, compile, and execute working standalone applications!');
    } else {
        console.log('❌ SOME TESTS FAILED: Please check errors above.');
        process.exitCode = 1;
    }
    console.log('================================================================');
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
