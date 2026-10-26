/**
 * Backfill the district and object training pairs of builds finished before the capture existed
 * (packages/core/src/node/cloud-store/training-pair-backfill.ts). Records them in the durable asset store; with
 * --upload also sends them, and every other training record still waiting, to the training bucket
 * (SCRATCHBOX_TRAINING_BUCKET or trainingBucket in <scratchbox home>/cloud-store.json).
 *
 *   npx ts-node --transpile-only -P desktop-app/tsconfig.electron.json scripts/backfill_training_pairs.ts [--upload]
 */
import { defaultDurableAssetStore } from '../packages/core/src/node/asset-store/durable-asset-store';
import { backfillTrainingPairs } from '../packages/core/src/node/cloud-store/training-pair-backfill';
import { defaultTrainingBucket, pendingTrainingPairs, uploadTrainingRecord, uploadableTrainingPair } from '../packages/core/src/node/cloud-store/training-pair-capture';
import { sweepPendingBuildingTraining } from '../packages/core/src/node/cloud-store/building-training-capture';

(async () => {
    const store = defaultDurableAssetStore();
    if (!store) throw new Error('no durable asset store (SCRATCHBOX_HOME is not set up)');
    const report = backfillTrainingPairs(store);
    const by = new Map<string, number>();
    for (const p of report.pairs) by.set(`${p.category}/${p.kind} ${p.outcome}`, (by.get(`${p.category}/${p.kind} ${p.outcome}`) ?? 0) + 1);
    console.log(`scenes: ${report.scenes}; pairs recorded: ${report.pairs.length}`);
    for (const [k, n] of by) console.log(`  ${n} ${k}`);
    for (const s of report.skipped) console.log(`  skipped run ${s.runId}: ${s.reason}`);
    if (!process.argv.includes('--upload')) { console.log('recorded locally only (pass --upload to send them to the training bucket)'); return; }
    const bucket = defaultTrainingBucket();
    if (!bucket) throw new Error('no training bucket configured (SCRATCHBOX_TRAINING_BUCKET or trainingBucket in cloud-store.json)');
    const pending = pendingTrainingPairs(store);
    for (const p of pending) await uploadTrainingRecord(store, bucket, uploadableTrainingPair(p));
    await sweepPendingBuildingTraining(store, bucket);
    console.log(`uploaded ${pending.length} pair record(s) to ${bucket.label}`);
})().catch(e => { console.error(e.message ?? e); process.exit(1); });
