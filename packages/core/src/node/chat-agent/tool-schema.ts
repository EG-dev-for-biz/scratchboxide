/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tool declarations are written once, in the OpenAPI subset Gemini reads (uppercase types: OBJECT, STRING, ...), and
 * translated here into the JSON Schema Claude's `input_schema` and OpenAI's function `parameters` take.
 */

import type { ToolDeclaration, ToolParameterSchema } from '../gemini/tools/types';

export type JsonSchema = {
    type?: string | string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    [key: string]: unknown;
};

/** Keywords that mean the same in both dialects and pass through unchanged. */
const PASS_THROUGH = ['description', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'default'] as const;

/** One schema node in JSON Schema. Arrays always get `items` (OpenAI rejects an array without one). */
export function toJsonSchema(schema: ToolParameterSchema | undefined): JsonSchema {
    if (!schema || typeof schema !== 'object') return {};
    const raw = schema as unknown as Record<string, unknown> & { type?: unknown; nullable?: unknown; enum?: unknown; properties?: Record<string, ToolParameterSchema>; required?: unknown; items?: ToolParameterSchema };
    const out: JsonSchema = {};
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
    if (type) out.type = raw.nullable === true ? [type, 'null'] : type;
    for (const key of PASS_THROUGH) {
        if (raw[key] !== undefined) (out as Record<string, unknown>)[key] = raw[key];
    }
    if (Array.isArray(raw.enum)) out.enum = [...raw.enum];
    if (raw.properties && typeof raw.properties === 'object') {
        out.properties = Object.fromEntries(Object.entries(raw.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    }
    if (Array.isArray(raw.required) && raw.required.length > 0) {
        // A required name with no property is a declaration slip both providers reject; it is left out.
        const required = raw.required.filter((n): n is string => typeof n === 'string');
        const names = out.properties ? required.filter(n => n in out.properties!) : required;
        if (names.length > 0) out.required = names;
    }
    if (type === 'array') out.items = raw.items ? toJsonSchema(raw.items) : {};
    if (type === 'object' && !out.properties) out.properties = {};
    return out;
}

/** A tool's input schema: always an object (a tool without parameters takes an empty one). */
export function toolInputSchema(declaration: ToolDeclaration): JsonSchema & { type: 'object' } {
    const schema = toJsonSchema(declaration.parameters);
    if (schema.type !== 'object') {
        return { type: 'object', properties: {} };
    }
    return { ...schema, type: 'object', properties: schema.properties || {} };
}
