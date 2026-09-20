import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Google360PanoramaPipelineService } from '../packages/core/src/node/spatial/Google360PanoramaPipelineService';
import { decodePng, encodePng } from '../packages/core/src/node/texture-processing';

interface MonumentalAsset {
    id: string;
    name: string;
    rawPath: string;
    outputFileName: string;
}

const BRAIN_DIR = '/Users/eligreen/.gemini/antigravity/brain/016a132b-a215-486a-84a6-1b8dfac77ac6';
const PUBLIC_IMAGES_DIR = path.resolve(__dirname, '../public/images');

const ASSETS: MonumentalAsset[] = [
    {
        id: 'crystal_cavern',
        name: 'Subterranean Geothermal Crystal Cavern Biosphere',
        rawPath: path.join(BRAIN_DIR, 'structured_crystal_cavern_1789853457265.png'),
        outputFileName: 'crystal_cavern_360_16k.jpg'
    },
    {
        id: 'kyoto_bamboo',
        name: 'Neo-Kyoto Bamboo Forest Glass Sanctuary',
        rawPath: path.join(BRAIN_DIR, 'test_structured_kyoto_1789852968090.png'),
        outputFileName: 'kyoto_bamboo_360_16k.jpg'
    },
    {
        id: 'pantheon_atrium',
        name: 'Colossal Pantheon Cathedral Atrium',
        rawPath: path.join(BRAIN_DIR, 'structured_pantheon_atrium_1789853485237.png'),
        outputFileName: 'pantheon_atrium_360_16k.jpg'
    },
    {
        id: 'orbital_station',
        name: 'Orbital Station Observation Biodome',
        rawPath: path.join(BRAIN_DIR, 'structured_orbital_station_1789853512982.png'),
        outputFileName: 'orbital_station_360_16k.jpg'
    },
    {
        id: 'desert_canyon',
        name: 'Desert Canyon Cantilever Infinity Terrace',
        rawPath: path.join(BRAIN_DIR, 'structured_desert_canyon_1789853540146.png'),
        outputFileName: 'desert_canyon_360_16k.jpg'
    },
    {
        id: 'cyberpunk_megacity',
        name: 'Cyberpunk Mega-City Skybridge Plaza',
        rawPath: path.join(BRAIN_DIR, 'structured_cyberpunk_megacity_1789853570559.png'),
        outputFileName: 'cyberpunk_megacity_360_16k.jpg'
    }
];

async function main() {
    console.log('========================================================================');
    console.log('🌟 MONUMENTAL 16K SPHERICAL 360 PANORAMA GENERATION PIPELINE');
    console.log('Method: Canonical Structured JSON 360 Ingest -> 2-Band Laplacian Seam Heal -> 16K Upscale -> 4:4:4 JPEG');
    console.log('Target Dimensions: 16384 x 8192 (134.2 Megapixels per environment)');
    console.log('========================================================================\n');

    if (!fs.existsSync(PUBLIC_IMAGES_DIR)) {
        fs.mkdirSync(PUBLIC_IMAGES_DIR, { recursive: true });
    }

    const service = new Google360PanoramaPipelineService();

    for (let i = 0; i < ASSETS.length; i++) {
        const asset = ASSETS[i];
        console.log(`[${i + 1}/${ASSETS.length}] Processing: ${asset.name}`);
        console.log(`  Source: ${path.basename(asset.rawPath)}`);

        if (!fs.existsSync(asset.rawPath)) {
            throw new Error(`Raw file missing: ${asset.rawPath}`);
        }

        // Step 1: Resample raw structured generation to standard 2:1 4K equirectangular (4096x2048)
        const tmp4kResampled = path.join(PUBLIC_IMAGES_DIR, `tmp_${asset.id}_4k_resampled.png`);
        execSync(`sips -z 2048 4096 "${asset.rawPath}" --out "${tmp4kResampled}"`, { stdio: 'pipe' });

        const dec4k = decodePng(fs.readFileSync(tmp4kResampled));
        let rgba4k = dec4k.rgba;
        const w4k = dec4k.width;
        const h4k = dec4k.height;

        // Step 2: Apply Street View Polar Caps at 4K (Zenith and Nadir)
        console.log(`  Applying Street View Polar Caps at 4K (zenithRatio: 0.12, nadirRatio: 0.12)...`);
        rgba4k = Google360PanoramaPipelineService.applyStreetViewPolarCaps(
            rgba4k,
            w4k,
            h4k,
            { zenithRatio: 0.12, nadirRatio: 0.12, smoothExponent: 2.0, azimuthalBlurRadius: 64 }
        );

        // Step 3: 2-Band Laplacian Seam Healing with Polar-Aware Harmonic Scaling
        console.log(`  Applying 2-band Laplacian seam equalization (seamWidth: 128px, polar-aware)...`);
        const shifted = Google360PanoramaPipelineService.shiftImageHorizontally(rgba4k, w4k, h4k, 0.5, false);
        const healed = Google360PanoramaPipelineService.proceduralSeamHeal(shifted, w4k, h4k, 128, 'laplacian_2band');
        const unshifted = Google360PanoramaPipelineService.shiftImageHorizontally(healed, w4k, h4k, 0.5, true);

        // Step 4: Enforce Bit-Exact Boundary Seam
        console.log(`  Enforcing Bit-Exact Boundary Seam across meridian...`);
        const seamless4k = Google360PanoramaPipelineService.enforceBitExactBoundarySeam(unshifted, w4k, h4k, 16);

        // Step 5: Add Cyclic Boundary Wrap Pre-Padding (+64px margin on each flank)
        console.log(`  Adding Cyclic Boundary Wrap Pre-Padding (+64px margin -> 4224x2048)...`);
        const margin4k = 64;
        const padded = Google360PanoramaPipelineService.addCyclicBoundaryPadding(seamless4k, w4k, h4k, margin4k);
        const tmp4kPadded = path.join(PUBLIC_IMAGES_DIR, `tmp_${asset.id}_4k_padded.png`);
        fs.writeFileSync(tmp4kPadded, encodePng(padded.paddedWidth, padded.paddedHeight, padded.paddedRgba));

        // Step 6: Apple vImage Hardware-Accelerated 4x Upscaling with Wrap Margins (4224x2048 -> 16896x8192)
        const tmp16kPadded = path.join(PUBLIC_IMAGES_DIR, `tmp_${asset.id}_16k_padded.png`);
        console.log(`  Hardware-accelerated 4x upscaling to 16896x8192 with wrap margins...`);
        execSync(`sips -z 8192 16896 "${tmp4kPadded}" --out "${tmp16kPadded}"`, { stdio: 'pipe' });

        // Step 7: Crop cyclic margins (256px on each flank) and encode to 4:4:4 High-Efficiency JPEG (16384x8192)
        const finalJpgPath = path.join(PUBLIC_IMAGES_DIR, asset.outputFileName);
        console.log(`  Cropping 256px cyclic margins and encoding 4:4:4 High-Efficiency JPEG (q=2)...`);
        execSync(`ffmpeg -y -i "${tmp16kPadded}" -vf "crop=16384:8192:256:0" -pix_fmt yuv444p -q:v 2 "${finalJpgPath}"`, { stdio: 'pipe' });

        // Clean up temporary files
        if (fs.existsSync(tmp4kResampled)) fs.unlinkSync(tmp4kResampled);
        if (fs.existsSync(tmp4kPadded)) fs.unlinkSync(tmp4kPadded);
        if (fs.existsSync(tmp16kPadded)) fs.unlinkSync(tmp16kPadded);

        // Step 8: Quality Control (QC) Audit
        console.log(`  Running Automated Quality Control (QC) Audit on 16K output...`);
        const audit = await service.auditPanoramaQuality({
            inputImagePath: finalJpgPath
        });

        // Verification
        const stat = fs.statSync(finalJpgPath);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        const dims = execSync(`sips -g pixelWidth -g pixelHeight "${finalJpgPath}"`).toString();
        const wMatch = dims.match(/pixelWidth:\s*(\d+)/);
        const hMatch = dims.match(/pixelHeight:\s*(\d+)/);
        const actualW = wMatch ? parseInt(wMatch[1], 10) : 0;
        const actualH = hMatch ? parseInt(hMatch[1], 10) : 0;

        console.log(`  QC Result: ${audit.pass ? '✅ PASS' : '❌ FAIL'} | Score: ${audit.qualityScore}/100`);
        console.log(`    Meridian RMS: ${audit.metrics.meridianRms.toFixed(4)}/255 | Zenith σ: ${audit.metrics.zenithStdDev.toFixed(4)}/255 | Nadir σ: ${audit.metrics.nadirStdDev.toFixed(4)}/255`);
        console.log(`  ✅ Complete: ${asset.outputFileName}`);
        console.log(`     Resolution: ${actualW} x ${actualH} (${((actualW * actualH) / 1e6).toFixed(1)} MP) | Size: ${sizeMb} MB\n`);

        if (!audit.pass) {
            throw new Error(`QC Audit FAILED for ${asset.name}: ${audit.violations.join(', ')}`);
        }
    }

    console.log('========================================================================');
    console.log('🎉 ALL 6 MONUMENTAL 16K 360 ENVIRONMENTS PROCESSED AND VERIFIED!');
    console.log('========================================================================');
}

main().catch(err => {
    console.error('Fatal error in monumental 16K generation:', err);
    process.exit(1);
});
