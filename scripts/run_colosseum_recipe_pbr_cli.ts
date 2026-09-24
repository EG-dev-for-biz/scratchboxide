import { runColosseumRecipePbrPipeline, type RecipePipelineOptions } from './apply_colosseum_recipe_pbr_suite';

const ktx2Arg = (process.env.RECIPE_KTX2 || '').trim();
const ktx2 = (['etc1s', 'uastc', 'off'].includes(ktx2Arg) ? ktx2Arg : 'etc1s') as RecipePipelineOptions['ktx2'];

runColosseumRecipePbrPipeline({ ktx2 }).catch(err => {
  console.error('Recipe PBR pipeline failed:', err);
  process.exit(1);
});
