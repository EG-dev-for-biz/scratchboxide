# Google Generative AI: Developer API (AI Studio) vs. Vertex AI Architecture

Google provides two primary entry points for accessing Generative AI models. As a Google Developer, you have access to both, but they serve distinct stages of development, latency tiers, and model lifecycles.

---

## 1. Quick Comparison Matrix

| Feature | Developer API (Google AI Studio) | Google Cloud Vertex AI |
|---|---|---|
| **Primary Target** | Rapid prototyping, experimental checkpoints, developer sandboxes | Production enterprise pipelines, custom endpoints, private VPCs, SLA backing |
| **Authentication** | API Key (`GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY`) | Google Cloud Service Account JSON / ADC (`gcloud auth application-default login`) |
| **SDK** | `@google/genai` (`new GoogleGenAI({ apiKey })`) | `@google/genai` (`new GoogleGenAI({ vertexAI: { project, location } })`) or `@google-cloud/vertexai` |
| **Base Endpoint** | `https://generativelanguage.googleapis.com/v1beta/` | `https://{location}-aiplatform.googleapis.com/v1/` or `v1beta1/` |
| **Experimental Models** | Available immediately (`gemini-2.0-flash-thinking-exp`, `gemini-exp-*`) | Released later or via Vertex Model Garden Partner previews |
| **Pre-GA / Interactions API** | Standard chat & content generation | Advanced multimodal video/speech (`locations/global/interactions`, Omni 1.1) |
| **Grounding** | Google Search Grounding | Google Search + Enterprise Datastores + Vertex Search |
| **Rate Limits & Quota** | Generous free tier for experimental models; pay-as-you-go tier | Cloud project quotas (QPM/TPM per region), configurable via Cloud Console |

---

## 2. Authentication Architecture in Scratchbox IDE

The unified runner script automatically resolves credentials using the following priority waterfall:

### Priority 1: Google AI Studio API Key
1. `secrets.json` -> `GEMINI_API_KEY`
2. `secrets.json` -> `GOOGLE_GENAI_API_KEY`
3. `secrets.json` -> `GOOGLE_AI_API_KEY`
4. Environment variable `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY`

```javascript
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
```

### Priority 2: Google Cloud Service Account (Vertex AI)
1. `secrets.json` -> `GOOGLE_SERVICE_ACCOUNT_JSON`
2. `secrets.json` -> `GOOGLE_APPLICATION_CREDENTIALS` (file path or JSON string)
3. Environment variable `GOOGLE_APPLICATION_CREDENTIALS`

```javascript
import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({
  vertexAI: {
    project: serviceAccount.project_id || 'scratchbox-canvas',
    location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'
  }
});
```

### Priority 3: gcloud Application Default Credentials (ADC)
When developing locally without explicit JSON files:
```bash
gcloud auth application-default login
gcloud config set project <PROJECT_ID>
```

---

## 3. GA vs. Non-GA Lifecycle Stages

Google Generative AI models progress through distinct lifecycle stages:

### Stage 1: Experimental (`-exp`)
- **Naming Pattern**: `gemini-2.0-flash-thinking-exp-01-21`, `gemini-2.0-pro-exp-02-05`, `gemini-exp-1206`
- **Characteristics**: Fast release cycle, bleeding-edge weights, transparent chain-of-thought scratchpads. Free on AI Studio with high rate limits.
- **Stability**: May be deprecated or replaced every 2-6 weeks.
- **Best For**: Creative problem-solving, architectural debugging, math invariant checking.

### Stage 2: Public Preview (`-preview` or `v1beta`)
- **Naming Pattern**: `gemini-3.8-flash`, `gemini-3.7-pro`, `veo-2.0-generate-001`, `imagen-3.0-capability-001`
- **Characteristics**: Near-final feature set, accessible via `v1beta` endpoints. Pricing and quotas active.
- **Best For**: Building features that leverage upcoming capabilities before general availability.

### Stage 3: General Availability (GA) (`-001`, `-002`, `latest`)
- **Naming Pattern**: `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro-002`, `imagen-3.0-generate-002`, `text-embedding-004`
- **Characteristics**: Supported by Google Enterprise Cloud SLAs, stable API contracts, guaranteed backward compatibility.
- **Best For**: Production deployments, continuous integration gates, user-facing tools.

### Stage 4: Whitelisted / Pre-GA / Trusted Tester
- **Naming Pattern**: `gemini-omni-1.1-flash-preview`, `veo-3-preview`
- **Characteristics**: Restrictive access requiring project whitelisting or specific API headers (e.g., `Api-Revision: 2026-05-20`, `locations/global/interactions`).
- **Best For**: Cinematic video blockout matchmoving, high-fidelity neural physics.

---

## 4. Unified `@google/genai` Client Usage

The official unified Google GenAI SDK (`@google/genai`) supports both Developer API and Vertex AI through a single surface:

```javascript
import { GoogleGenAI } from '@google/genai';

// Switch between AI Studio and Vertex by changing initialization:
const aiStudioClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const vertexClient = new GoogleGenAI({
  vertexAI: {
    project: 'my-project-id',
    location: 'us-central1'
  }
});

// Calling syntax is 100% identical across both:
const response = await client.models.generateContent({
  model: 'gemini-2.5-pro',
  contents: 'Synthesize a C++20 Signed Distance Field kernel'
});
console.log(response.text);
```
