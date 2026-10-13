import { NativeCppCompilerService } from './packages/core/src/node/3d-engine/native-compiler-service';

// Build the native engine PCH once before workers fork, so parallel C++ tests don't each pay a cold ~20s parse.
export default async function setup(): Promise<void> {
    await new NativeCppCompilerService().ensurePrecompiledHeader();
}
