/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export type NamingCasing = 'camelCase' | 'PascalCase' | 'snake_case' | 'kebab-case' | 'SCREAMING_SNAKE_CASE';

export interface NamingConvention {
    variables: NamingCasing;
    functions: NamingCasing;
    classes: NamingCasing;
    interfaces: NamingCasing;
    types: NamingCasing;
    files: NamingCasing;
    interfaceNamingStyle: 'I-prefixed' | 'Props-suffixed' | 'standard';
    serviceNamingStyle: 'Service-suffixed' | 'Manager-suffixed' | 'standard';
}

export type ErrorHandlingPattern =
    | 'try-catch'
    | 'result-type'
    | 'custom-error-class'
    | 'graceful-fallback'
    | 'error-codes'
    | 'promise-catch';

export interface ErrorHandlingConvention {
    primaryPattern: ErrorHandlingPattern;
    useCustomErrorHierarchy: boolean;
    customErrorBaseClasses: string[];
    loggerPattern?: string;
    exemplarSnippet?: string;
}

export type ComponentParadigm =
    | 'functional-hooks'
    | 'class-component'
    | 'inversify-widget'
    | 'vanilla-dom'
    | 'none';

export interface ComponentPattern {
    paradigm: ComponentParadigm;
    uiLibrary: 'spectrum' | 'scratchbox-widget' | 'react-dom' | 'custom-css' | 'tailwind' | 'unknown';
    stateHookUsage: 'useState' | 'useReducer' | 'zustand' | 'redux' | 'inversify-property' | 'local-state';
    propsInterfaceNaming: string;
    exemplarSnippet?: string;
}

export type StateManagementArchitecture =
    | 'inversify-di'
    | 'react-context'
    | 'zustand'
    | 'redux'
    | 'event-emitter'
    | 'signals'
    | 'module-state';

export interface StateManagementConvention {
    architecture: StateManagementArchitecture;
    usesDependencyInjection: boolean;
    diFramework?: 'inversify' | 'tsyringe' | 'custom';
    exemplarSnippet?: string;
}

export type TestFramework = 'assert' | 'jest' | 'mocha' | 'vitest' | 'custom-suite';
export type TestStyle = 'assert-strict' | 'bdd-describe-it' | 'async-suite' | 'property-testing';

export interface TestingConvention {
    framework: TestFramework;
    style: TestStyle;
    runnerCommand: string;
    exemplarSnippet?: string;
}

export interface FewShotExemplar {
    id: string;
    category: 'naming' | 'error_handling' | 'component' | 'state_management' | 'testing' | 'general';
    title: string;
    filePath?: string;
    snippet: string;
    explanation: string;
    relevanceTags: string[];
}

export interface CodebasePatternAnalysis {
    workspaceRoot: string;
    primaryLanguages: string[];
    naming: NamingConvention;
    errorHandling: ErrorHandlingConvention;
    component: ComponentPattern;
    stateManagement: StateManagementConvention;
    testing: TestingConvention;
    fewShotExemplars: FewShotExemplar[];
    summaryPromptContext: string;
    analyzedFilesCount: number;
    lastAnalyzed: number;
}

export interface PatternExtractionOptions {
    maxExemplars?: number;
    sampleFiles?: string[];
    language?: string;
    includeSnippets?: boolean;
}
