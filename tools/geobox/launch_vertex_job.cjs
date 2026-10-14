/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Google Cloud Vertex AI Job Launcher for GeoBox.
 * Submits custom distributed training jobs to Google Cloud Vertex AI using service account credentials.
 */

const fs = require('fs');
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

function loadCredentials() {
    const candidatePaths = [
        path.resolve(__dirname, '../../secrets.json'),
        path.resolve(__dirname, '../../service-account.json')
    ];

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw.GOOGLE_SERVICE_ACCOUNT_JSON) {
                return typeof raw.GOOGLE_SERVICE_ACCOUNT_JSON === 'string'
                    ? JSON.parse(raw.GOOGLE_SERVICE_ACCOUNT_JSON)
                    : raw.GOOGLE_SERVICE_ACCOUNT_JSON;
            }
            if (raw.client_email && raw.private_key) {
                return raw;
            }
        }
    }
    return null;
}

async function main() {
    const args = process.argv.slice(2);
    const isDryRun = args.includes('--dry-run');
    const useTpu = args.includes('--tpu');
    const region = 'us-central1';

    console.log('🌍 [GeoBox Cloud Launcher] Preparing Vertex AI Training Submission...');

    const credentials = loadCredentials();
    if (!credentials) {
        console.warn('⚠️ No GCP service account found in secrets.json or service-account.json. Simulating submission.');
    }

    const projectId = credentials?.project_id || 'scoutscan';
    console.log(`🔑 GCP Project: ${projectId}`);
    console.log(`📍 Region: ${region}`);
    // Determine compute profile
    let machineSpec;
    let modeLabel;

    if (useTpu) {
        modeLabel = 'Cloud TPU v5e (v5e-16 Pod Slice)';
        machineSpec = {
            machineType: 'ct5lp-hightpu-4t',
            acceleratorType: 'TPU_V5_LITEPOD',
            acceleratorCount: 16
        };
    } else if (args.includes('--l4')) {
        modeLabel = 'NVIDIA L4 (24GB GPU)';
        machineSpec = {
            machineType: 'g2-standard-8',
            acceleratorType: 'NVIDIA_L4',
            acceleratorCount: 1
        };
    } else if (args.includes('--t4')) {
        modeLabel = 'NVIDIA T4 (16GB GPU)';
        machineSpec = {
            machineType: 'n1-standard-8',
            acceleratorType: 'NVIDIA_TESLA_T4',
            acceleratorCount: 1
        };
    } else if (args.includes('--a100-1g') || args.includes('--a100')) {
        modeLabel = 'NVIDIA A100 (40GB GPU)';
        machineSpec = {
            machineType: 'a2-highgpu-1g',
            acceleratorType: 'NVIDIA_TESLA_A100',
            acceleratorCount: 1
        };
    } else if (args.includes('--cpu')) {
        modeLabel = 'Standard CPU (n1-standard-16)';
        machineSpec = {
            machineType: 'n1-standard-16'
        };
    } else {
        modeLabel = 'NVIDIA A100 (80GB SXM) Multi-GPU (8x)';
        machineSpec = {
            machineType: 'a2-ultragpu-8g',
            acceleratorType: 'NVIDIA_A100_80GB',
            acceleratorCount: 8
        };
    }

    console.log(`⚡ Compute Profile: ${modeLabel}`);

    const imageUri = `us-central1-docker.pkg.dev/${projectId}/depthbox3-repo/geobox-trainer:latest`;

    // Construct Vertex AI Custom Job Payload
    const customJobPayload = {
        displayName: `geobox-training-${Date.now()}`,
        jobSpec: {
            workerPoolSpecs: [
                {
                    machineSpec: machineSpec,
                    replicaCount: 1,
                    containerSpec: {
                        imageUri: imageUri,
                        args: [
                            '--epochs', args.includes('--quick') ? '1' : '20',
                            '--batch-size', useTpu ? '256' : (args.includes('--l4') || args.includes('--t4') ? '32' : '128'),
                            '--lr', '1e-4',
                            '--embed-dim', '512',
                            '--gcs-train-data', `gs://${projectId}-geobox/data/train/*.tar`,
                            '--output-dir', `gs://${projectId}-geobox/checkpoints/run_${Date.now()}`
                        ]
                    }
                }
            ],
            baseOutputDirectory: {
                outputUriPrefix: `gs://${projectId}-geobox/checkpoints/`
            }
        }
    };

    console.log('\n📄 [Job Specification Payload]:');
    console.log(JSON.stringify(customJobPayload, null, 2));

    if (isDryRun || !credentials) {
        console.log('\n✅ [Dry Run] Payload verified. Job ready for submission with:');
        console.log(`   node tools/geobox/launch_vertex_job.cjs`);
        return;
    }

    const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });

    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;
    console.log('✅ Acquired OAuth2 access token for Vertex AI API.');

    const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/customJobs`;
    console.log(`🚀 Submitting to: ${endpoint}`);

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(customJobPayload)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`❌ Vertex AI Job submission failed (${res.status}): ${errorText}`);
        process.exit(1);
    }

    const jobResult = await res.json();
    console.log(`\n🎉 Vertex AI Job successfully launched!`);
    console.log(`🆔 Job Name: ${jobResult.name}`);
    console.log(`📊 State: ${jobResult.state}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
