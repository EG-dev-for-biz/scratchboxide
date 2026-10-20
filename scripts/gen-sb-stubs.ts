/**
 * npm run stubs:sb — regenerates the scratchbox Python API stubs (packages/core/src/python/typings) and the API
 * summary module (packages/core/src/node/3d-engine/sb-api.generated.ts) from the live module. Commit both.
 */
import { generateSbStubs } from '../packages/core/src/node/3d-engine/sb-stubs';

generateSbStubs().then(report => {
    console.log(`scratchbox stubs ${report.version}: ${report.stubFiles} files, ${report.inferredReturnsApplied} inferred return types, ` +
        `summary ${report.fullSummaryChars} / ${report.coreSummaryChars} chars`);
    if (report.patches.length) console.log(`patches:\n  ${report.patches.join('\n  ')}`);
    if (report.unknownReturns.length) console.log(`return types left unknown (${report.unknownReturns.length}): ${report.unknownReturns.join(', ')}`);
}).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
