import { NativeCppCompilerService } from './packages/core/src/node/3d-engine/native-compiler-service';
import { NativePythonRunnerService } from './packages/core/src/node/3d-engine/native-python-runner-service';

// Build native artifacts once before workers fork, so parallel tests don't each pay (or race for) the cold build.
export default async function setup(): Promise<void> {
    const [, pythonBuildError] = await Promise.all([
        new NativeCppCompilerService().ensurePrecompiledHeader(),
        NativePythonRunnerService.getInstance().ensureNativeModule()
    ]);
    if (pythonBuildError) {
        console.warn(`[vitest] scratchbox_native unavailable; Python engine tests will fail: ${pythonBuildError.slice(0, 500)}`);
    }
}
