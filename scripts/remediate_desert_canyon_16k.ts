import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Google360PanoramaPipelineService } from '../packages/core/src/node/spatial/Google360PanoramaPipelineService';
import { decodePng, encodePng } from '../packages/core/src/node/texture-processing';

const BRAIN_DIR = '/Users/eligreen/.gemini/antigravity/brain/016a132b-a215-486a-84a6-1b8dfac77ac6';
const PUBLIC_IMAGES_DIR = path.resolve(__dirname, '../public/images');
const RAW_PATH = path.join(BRAIN_DIR, 'structured_desert_canyon_1789853540146.png');
const FINAL_JPG = path.join(PUBLIC_IMAGES_DIR, 'desert_canyon_360_16k.jpg');

async function main() {
    console.log('=== REMEDIATING DESERT CANYON 16K PANORAMA ===');
    console.log(`Input: ${RAW_PATH}`);

    // Step 1: Resample raw to 4K (4096 x 2048)
    const tmp4k = path.join(PUBLIC_IMAGES_DIR, 'tmp_dc_4k.png');
    execSync(`sips -z 2048 4096 "${RAW_PATH}" --out "${tmp4k}"`, { stdio: 'pipe' });

    const dec4k = decodePng(fs.readFileSync(tmp4k));
    let rgba4k = dec4k.rgba;
    const w4k = dec4k.width;
    const h4k = dec4k.height;

    // Step 2: Apply Street View Polar Caps (Zenith and Nadir)
    console.log('Applying Street View Polar Caps at 4K...');
    rgba4k = Google360PanoramaPipelineService.applyStreetViewPolarCaps(
        rgba4k,
        w4k,
        h4k,
        { zenithRatio: 0.12, nadirRatio: 0.12, smoothExponent: 2.0, azimuthalBlurRadius: 64 }
    );

    // Step 3: 2-Band Laplacian Seam Equalization with Polar-Aware Harmonic Scaling
    console.log('Applying 2-band Laplacian Seam Equalization...');
    const shifted = Google360PanoramaPipelineService.shiftImageHorizontally(rgba4k, w4k, h4k, 0.5, false);
    const healed = Google360PanoramaPipelineService.proceduralSeamHeal(shifted, w4k, h4k, 128, 'laplacian_2band');
    const unshifted = Google360PanoramaPipelineService.shiftImageHorizontally(healed, w4k, h4k, 0.5, true);

    // Step 4: Enforce Bit-Exact Boundary Seam
    console.log('Enforcing Bit-Exact Boundary Seam...');
    const seamless4k = Google360PanoramaPipelineService.enforceBitExactBoundarySeam(unshifted, w4k, h4k, 16);

    // Step 5: Add Cyclic Boundary Wrap Pre-Padding (+64px margin on each flank)
    console.log('Adding Cyclic Boundary Wrap Pre-Padding (+64px margin)...');
    const margin4k = 64;
    const padded = Google360PanoramaPipelineService.addCyclicBoundaryPadding(seamless4k, w4k, h4k, margin4k);
    const tmp4kPadded = path.join(PUBLIC_IMAGES_DIR, 'tmp_dc_4k_padded.png');
    fs.writeFileSync(tmp4kPadded, encodePng(padded.paddedWidth, padded.paddedHeight, padded.paddedRgba));

    // Step 6: Apple vImage Hardware-Accelerated 4x Upscaling (4224x2048 -> 16896x8192)
    console.log('Hardware-accelerated 4x upscaling with cyclic margins to 16896x8192...');
    const tmp16kPadded = path.join(PUBLIC_IMAGES_DIR, 'tmp_dc_16k_padded.png');
    execSync(`sips -z 8192 16896 "${tmp4kPadded}" --out "${tmp16kPadded}"`, { stdio: 'pipe' });

    // Step 7: Crop cyclic margins (256px on each flank) and encode to 4:4:4 High-Efficiency JPEG
    console.log('Cropping 256px cyclic margins and encoding 4:4:4 JPEG (16384x8192)...');
    execSync(`ffmpeg -y -i "${tmp16kPadded}" -vf "crop=16384:8192:256:0" -pix_fmt yuv444p -q:v 2 "${FINAL_JPG}"`, { stdio: 'pipe' });

    // Cleanup temp files
    if (fs.existsSync(tmp4k)) fs.unlinkSync(tmp4k);
    if (fs.existsSync(tmp4kPadded)) fs.unlinkSync(tmp4kPadded);
    if (fs.existsSync(tmp16kPadded)) fs.unlinkSync(tmp16kPadded);

    // Step 8: Quality Control (QC) Audit
    console.log('\nRunning Automated Quality Control (QC) Audit on 16K output...');
    const auditService = new Google360PanoramaPipelineService();
    const auditResult = await auditService.auditPanoramaQuality({
        inputImagePath: FINAL_JPG
    });

    console.log('----------------------------------------------------');
    console.log(`QC Audit Result: ${auditResult.pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Quality Score: ${auditResult.qualityScore} / 100`);
    console.log(`Metrics:`);
    console.log(`  Meridian RMS Error: ${auditResult.metrics.meridianRms.toFixed(4)} / 255`);
    console.log(`  Meridian Max Delta: ${auditResult.metrics.meridianMaxDelta.toFixed(4)} / 255`);
    console.log(`  Zenith Std Dev (Row 0): ${auditResult.metrics.zenithStdDev.toFixed(4)} / 255`);
    console.log(`  Nadir Std Dev (Row H-1): ${auditResult.metrics.nadirStdDev.toFixed(4)} / 255`);
    console.log(`  Ceiling Discontinuity: ${auditResult.metrics.zenithMeridianDiscontinuity.toFixed(4)} / 255`);
    if (auditResult.violations.length > 0) {
        console.log(`Violations:`);
        auditResult.violations.forEach(v => console.log(`  - ${v}`));
    }
    console.log('----------------------------------------------------');
}

main().catch(err => {
    console.error('Error in remediation:', err);
    process.exit(1);
});
