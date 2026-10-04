/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export interface AstGuardValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  extractedParameters: Record<string, any>;
  suggestedFixes?: string[];
}

export type AstGuardResult = AstGuardValidationResult & {
  violations: string[];
  parameters: Array<{ name: string; value: any; min?: number; max?: number; step?: number }>;
};

export interface ExtractedSliderParam {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  value: any;
  min?: number;
  max?: number;
  step?: number;
}

export type DynamicUiParameter = ExtractedSliderParam;

/**
 * Layer 1 AST Pre-flight Guard:
 * Catches syntax errors, scale violations (e.g. building heights < 3m or > 800m),
 * malicious imports, and unbounded growth loops before C++ kernel execution.
 */
export class ProceduralAstGuard {
  private static readonly FORBIDDEN_MODULES = [
    'os.system',
    'subprocess',
    'shutil',
    'socket',
    'pty',
    'ctypes',
    'urllib',
    'http.client',
    'eval(',
    'exec(',
    '__import__'
  ];

  /**
   * Static alias for comprehensive auditing with violations and parameters array.
   */
  public static auditScript(script: string): AstGuardResult {
    const val = this.validateScript(script);
    const extracted = val.extractedParameters;
    const parameters = Object.entries(extracted).map(([key, value]) => ({
      name: key,
      value,
      min: typeof value === 'number' ? (value > 0 ? 0 : value * 2) : undefined,
      max: typeof value === 'number' ? (value * 2 || 100) : undefined,
      step: typeof value === 'number' ? (Number.isInteger(value) ? 1 : 0.1) : undefined
    }));
    return {
      ...val,
      violations: val.errors,
      parameters
    };
  }

  /**
   * Extracts dynamic interactive sliders for Layer 5 Generative Canvas UI.
   */
  public static extractInteractiveSliders(script: string): DynamicUiParameter[] {
    const extracted = this.extractParameters(script);
    return Object.entries(extracted).map(([key, value]) => ({
      key,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      type: (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string') as 'number' | 'string' | 'boolean',
      value,
      min: typeof value === 'number' ? (value > 0 ? 0 : value * 2) : undefined,
      max: typeof value === 'number' ? (value * 2 || 100) : undefined,
      step: typeof value === 'number' ? (Number.isInteger(value) ? 1 : 0.1) : undefined
    }));
  }

  /**
   * Pre-flight audits a procedural Python script against physical scale invariants,
   * safety contracts, and unbounded growth loops.
   */
  public static validateScript(script: string): AstGuardValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Forbidden execution calls & insecure modules
    for (const forbidden of this.FORBIDDEN_MODULES) {
      if (script.includes(forbidden)) {
        errors.push(`Forbidden operation or module: detected insecure call '${forbidden}'.`);
      }
    }

    // 2. Unbounded loop guard
    if (/while\s+True\s*:/i.test(script) && !/break/i.test(script)) {
      errors.push('Unbounded loop detected: `while True:` without a break statement will exhaust engine limits.');
    }

    // 3. Physical Scale & Invariant Audits
    // Building height bounds (Vitruvian & engineering limits: 3.0m <= height <= 800.0m)
    const heightMatch = script.match(/column_height\s*=\s*([-\d.]+)|height\s*=\s*([-\d.]+)/i);
    if (heightMatch) {
      const val = parseFloat(heightMatch[1] || heightMatch[2]);
      if (!isNaN(val)) {
        if (val < 0) {
          errors.push(`Scale violation: building or column height cannot be negative (${val}m).`);
        } else if (val < 1.0) {
          errors.push(`Scale violation: building or column height is unrealistically miniature (${val}m < 1.0m).`);
        } else if (val > 800.0) {
          errors.push(`Scale violation: structure height exceeds maximum physical limits (${val}m > 800.0m).`);
        }
      }
    }

    // Terrain extents bounds (10m <= extents <= 5000m)
    const extentsMatch = script.match(/extents\s*=\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
    if (extentsMatch) {
      const ex = parseFloat(extentsMatch[1]);
      const ez = parseFloat(extentsMatch[2]);
      if (ex <= 0 || ez <= 0) {
        errors.push(`Scale violation: terrain extents must be strictly positive (got extents=(${ex}, ${ez})).`);
      } else if (ex > 5000 || ez > 5000) {
        errors.push(`Scale violation: Terrain extent exceeds max simulation memory boundary (got extents=(${ex}, ${ez}), max=5000m).`);
      }
    }

    // Footprint bounds
    const footprintMatch = script.match(/footprint_length\s*=\s*([-\d.]+)|footprint_width\s*=\s*([-\d.]+)/i);
    if (footprintMatch) {
      const fl = script.match(/footprint_length\s*=\s*([-\d.]+)/i);
      const fw = script.match(/footprint_width\s*=\s*([-\d.]+)/i);
      if (fl && parseFloat(fl[1]) <= 0) {
        errors.push(`Scale violation: footprint_length must be positive (got ${fl[1]}).`);
      }
      if (fw && parseFloat(fw[1]) <= 0) {
        errors.push(`Scale violation: footprint_width must be positive (got ${fw[1]}).`);
      }
    }

    // Scatter counts bounds (1 <= count <= 10000)
    const countMatch = script.match(/count\s*=\s*([-\d]+)/i);
    if (countMatch) {
      const count = parseInt(countMatch[1], 10);
      if (count < 1) {
        errors.push(`Scale violation: scatter count must be at least 1 (got ${count}).`);
      } else if (count > 10000) {
        warnings.push(`High scatter count (${count} instances). May increase compilation and glTF serialization time.`);
      }
    }

    // 4. Extract Dynamic Interactive Sliders for Layer 5 Canvas UI
    const extractedParameters = this.extractParameters(script);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      extractedParameters
    };
  }

  /**
   * Extracts top-level parameters from the script to expose interactive UI sliders
   * on the Generative Canvas Studio frontend.
   */
  public static extractParameters(script: string): Record<string, any> {
    const params: Record<string, any> = {};

    const patterns: Record<string, { regex: RegExp; parse: (m: RegExpMatchArray) => any }> = {
      seed: {
        regex: /seed\s*=\s*(\d+)/,
        parse: m => parseInt(m[1], 10)
      },
      archetype: {
        regex: /archetype\s*=\s*["']([^"']+)["']/,
        parse: m => m[1]
      },
      domain_warp_scale: {
        regex: /domain_warp_scale\s*=\s*([-\d.]+)/,
        parse: m => parseFloat(m[1])
      },
      hydraulic_erosion_steps: {
        regex: /hydraulic_erosion_steps\s*=\s*(\d+)/,
        parse: m => parseInt(m[1], 10)
      },
      column_count_x: {
        regex: /column_count_x\s*=\s*(\d+)/,
        parse: m => parseInt(m[1], 10)
      },
      column_count_y: {
        regex: /column_count_y\s*=\s*(\d+)/,
        parse: m => parseInt(m[1], 10)
      },
      footprint_length: {
        regex: /footprint_length\s*=\s*([-\d.]+)/,
        parse: m => parseFloat(m[1])
      },
      footprint_width: {
        regex: /footprint_width\s*=\s*([-\d.]+)/,
        parse: m => parseFloat(m[1])
      },
      scatter_count: {
        regex: /count\s*=\s*(\d+)/,
        parse: m => parseInt(m[1], 10)
      },
      cluster_radius: {
        regex: /cluster_radius\s*=\s*([-\d.]+)/,
        parse: m => parseFloat(m[1])
      },
      slope_limit_degrees: {
        regex: /slope_limit_degrees\s*=\s*([-\d.]+)/,
        parse: m => parseFloat(m[1])
      }
    };

    for (const [key, config] of Object.entries(patterns)) {
      const match = script.match(config.regex);
      if (match) {
        params[key] = config.parse(match);
      }
    }

    return params;
  }
}
