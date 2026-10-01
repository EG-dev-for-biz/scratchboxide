/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import fs from 'fs';
import { execSync } from 'child_process';

export interface GeminiDetectedObject2D {
  label: string;
  category: string;
  box2d: [number, number, number, number]; // [ymin, xmin, ymax, xmax] in 0-1000 scale
  confidence?: number;
}

export interface GeminiObjectDetectionTelemetry {
  model: string;
  durationMs: number;
  promptTokens: number;
  candidateTokens: number;
  totalTokens: number;
  costEstimateUSD: number;
  detectedCount: number;
}

export interface GeminiDetectionResult {
  success: boolean;
  objects: GeminiDetectedObject2D[];
  telemetry: GeminiObjectDetectionTelemetry;
  rawResponse?: string;
  error?: string;
}

/**
 * Service for running high-speed, cost-effective multimodal object detection
 * using Google Gemini 2.5 Flash / Flash-Lite via Vertex AI.
 * 
 * At $0.075 / 1M input tokens, a 4K viewport detection pass costs ~$0.0014 (less than 1/7th of a cent).
 */
export class GeminiMultimodalObjectDetectorService {
  public static readonly DEFAULT_MODEL = 'gemini-2.5-flash';
  public static readonly DEFAULT_PROJECT = 'scratchbox-canvas';
  public static readonly DEFAULT_LOCATION = 'us-central1';

  /**
   * Retrieves an active Google Cloud OAuth2 access token.
   * Supports env var, GCP Metadata server (Cloud Run), and gcloud CLI.
   */
  public static async getAccessToken(): Promise<string> {
    if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
      return process.env.GOOGLE_OAUTH_ACCESS_TOKEN.trim();
    }
    // Try Google Cloud Metadata Server (Cloud Run / GCE)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 800);
      const metaRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (metaRes.ok) {
        const metaData = await metaRes.json() as any;
        if (metaData.access_token) return metaData.access_token;
      }
    } catch (_) {
      // Not running in Cloud Run or metadata server unreachable
    }
    try {
      return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
    } catch (err) {
      throw new Error(`Failed to obtain Google Cloud access token via gcloud: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Detects 2D bounding boxes and semantic categories on an image using Gemini 2.5 Flash.
   */
  public static async detectObjectsFromImage(
    imagePathOrBase64: string,
    options?: {
      model?: string;
      project?: string;
      location?: string;
      customPrompt?: string;
    }
  ): Promise<GeminiDetectionResult> {
    const model = options?.model || this.DEFAULT_MODEL;
    const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || this.DEFAULT_PROJECT;
    const location = options?.location || this.DEFAULT_LOCATION;

    let base64Data: string;
    let mimeType = 'image/png';

    if (imagePathOrBase64.startsWith('data:image/')) {
      const match = imagePathOrBase64.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        base64Data = match[2];
      } else {
        base64Data = imagePathOrBase64;
      }
    } else if (fs.existsSync(imagePathOrBase64)) {
      if (imagePathOrBase64.endsWith('.jpg') || imagePathOrBase64.endsWith('.jpeg')) {
        mimeType = 'image/jpeg';
      } else if (imagePathOrBase64.endsWith('.webp')) {
        mimeType = 'image/webp';
      }
      base64Data = fs.readFileSync(imagePathOrBase64).toString('base64');
    } else {
      base64Data = imagePathOrBase64;
    }

    const promptText = options?.customPrompt || 
      'Detect all visible architectural entities, individual trees, ruins, monuments, street elements, and surrounding buildings in this 3D photogrammetric render. ' +
      'Return a clean JSON object with schema: { "objects": [ { "label": string, "category": string, "box_2d": [ymin, xmin, ymax, xmax] } ] }. ' +
      'Coordinates must be integers from 0 to 1000. Output ONLY valid JSON.';

    const token = await this.getAccessToken();
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data
              }
            },
            {
              text: promptText
            }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      })
    });

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        objects: [],
        telemetry: {
          model,
          durationMs,
          promptTokens: 0,
          candidateTokens: 0,
          totalTokens: 0,
          costEstimateUSD: 0,
          detectedCount: 0
        },
        error: `Vertex AI responded with HTTP ${response.status}: ${errorText}`
      };
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '{}';
    const usage = data.usageMetadata || {};

    const promptTokens = usage.promptTokenCount || 0;
    const candidateTokens = usage.candidatesTokenCount || 0;
    const totalTokens = usage.totalTokenCount || (promptTokens + candidateTokens);

    // Vertex Gemini 2.5 Flash pricing: $0.075 per 1M prompt tokens, $0.30 per 1M candidate tokens
    const costEstimateUSD = (promptTokens * 0.075 / 1000000) + (candidateTokens * 0.30 / 1000000);

    let parsedObjects: GeminiDetectedObject2D[] = [];
    try {
      const parsed = JSON.parse(text);
      const rawList = Array.isArray(parsed) ? parsed : (parsed.objects || []);
      parsedObjects = rawList.map((item: any) => ({
        label: String(item.label || item.name || 'Detected Object'),
        category: String(item.category || 'general'),
        box2d: Array.isArray(item.box_2d) && item.box_2d.length === 4
          ? [Number(item.box_2d[0]), Number(item.box_2d[1]), Number(item.box_2d[2]), Number(item.box_2d[3])]
          : [0, 0, 1000, 1000],
        confidence: item.confidence ? Number(item.confidence) : undefined
      }));
    } catch (parseErr) {
      return {
        success: false,
        objects: [],
        telemetry: {
          model,
          durationMs,
          promptTokens,
          candidateTokens,
          totalTokens,
          costEstimateUSD,
          detectedCount: 0
        },
        rawResponse: text,
        error: `JSON parse error on Gemini output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      };
    }

    return {
      success: true,
      objects: parsedObjects,
      telemetry: {
        model,
        durationMs,
        promptTokens,
        candidateTokens,
        totalTokens,
        costEstimateUSD,
        detectedCount: parsedObjects.length
      },
      rawResponse: text
    };
  }
}
