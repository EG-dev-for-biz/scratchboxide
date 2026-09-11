/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    CodebasePatternAnalysis,
    ComponentParadigm,
    ComponentPattern,
    ErrorHandlingConvention,
    ErrorHandlingPattern,
    FewShotExemplar,
    NamingCasing,
    NamingConvention,
    PatternExtractionOptions,
    StateManagementArchitecture,
    StateManagementConvention,
    TestFramework,
    TestingConvention,
    TestStyle
} from '../common/pattern-matching-protocol';

@injectable()
export class CodebasePatternEngine {
    private analysisCache: Map<string, CodebasePatternAnalysis> = new Map();

    /**
     * Analyzes codebase conventions across an active workspace directory and returns
     * structured few-shot patterns for Gemini and Deep-Write prompt injection.
     */
    async analyzeWorkspacePatterns(
        workspaceRoot: string,
        options: PatternExtractionOptions = {}
    ): Promise<CodebasePatternAnalysis> {
        const cached = this.analysisCache.get(workspaceRoot);
        if (cached && Date.now() - cached.lastAnalyzed < 60000) {
            return cached;
        }

        const files: Array<{ path: string; content: string }> = [];
        const sampleLimit = options.maxExemplars ? options.maxExemplars * 10 : 30;

        const walk = async (dir: string): Promise<void> => {
            if (files.length >= sampleLimit) return;
            if (!await fs.pathExists(dir)) return;

            const entries = await fs.readdir(dir);
            for (const entry of entries) {
                if (files.length >= sampleLimit) break;
                const fullPath = path.join(dir, entry);
                const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');

                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    if (['node_modules', '.git', 'dist', 'lib', 'build', '.cache', '.turbo', '.next'].includes(entry)) {
                        continue;
                    }
                    await walk(fullPath);
                } else if (stat.isFile()) {
                    const ext = path.extname(entry).toLowerCase();
                    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'].includes(ext)) {
                        if (options.sampleFiles && !options.sampleFiles.includes(relPath)) {
                            continue;
                        }
                        try {
                            const content = await fs.readFile(fullPath, 'utf8');
                            files.push({ path: relPath, content });
                        } catch {
                            // Skip unreadable files
                        }
                    }
                }
            }
        };

        await walk(workspaceRoot);
        const analysis = this.analyzeFilesPatterns(files, workspaceRoot, options);
        this.analysisCache.set(workspaceRoot, analysis);
        return analysis;
    }

    /**
     * Performs convention analysis on an in-memory list of files (e.g. sandbox tabs or scanned files).
     */
    analyzeFilesPatterns(
        files: Array<{ path: string; content: string }>,
        workspaceRoot: string = '',
        options: PatternExtractionOptions = {}
    ): CodebasePatternAnalysis {
        const languages = new Set<string>();
        const exemplars: FewShotExemplar[] = [];

        // Naming counters
        const varCasings = { camelCase: 0, snake_case: 0, PascalCase: 0 };
        const fnCasings = { camelCase: 0, snake_case: 0, PascalCase: 0 };
        const fileCasings = { 'kebab-case': 0, PascalCase: 0, camelCase: 0 };
        let iPrefixedCount = 0;
        let propsSuffixedCount = 0;
        let serviceSuffixedCount = 0;
        let managerSuffixedCount = 0;

        // Error handling counters
        let tryCatchCount = 0;
        let resultTypeCount = 0;
        let customErrorCount = 0;
        const customErrorClasses = new Set<string>();

        // Component counters
        let functionalHooksCount = 0;
        let classComponentCount = 0;
        let spectrumUiCount = 0;
        let reactDomCount = 0;
        let customCssCount = 0;

        // State & DI counters
        let inversifyDiCount = 0;
        let reactContextCount = 0;
        let zustandCount = 0;
        let reduxCount = 0;

        // Testing counters
        let assertCount = 0;
        let jestDescribeCount = 0;

        for (const file of files) {
            const ext = path.extname(file.path).toLowerCase();
            const baseName = path.basename(file.path, ext);

            // File language
            if (['.ts', '.tsx'].includes(ext)) languages.add('TypeScript');
            else if (['.js', '.jsx'].includes(ext)) languages.add('JavaScript');
            else if (ext === '.py') languages.add('Python');
            else if (ext === '.rs') languages.add('Rust');
            else if (ext === '.go') languages.add('Go');

            // File naming casing
            if (baseName.includes('-')) fileCasings['kebab-case']++;
            else if (/^[A-Z][a-zA-Z0-9]*$/.test(baseName)) fileCasings.PascalCase++;
            else if (/^[a-z][a-zA-Z0-9]*$/.test(baseName)) fileCasings.camelCase++;

            const content = file.content;
            const lines = content.split('\n');

            // 1. Scan naming schemes & AST tokens
            for (const line of lines) {
                const trimmed = line.trim();

                // Functions
                const fnMatch = trimmed.match(/(?:function\s+([a-zA-Z0-9_]+)|const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/);
                if (fnMatch) {
                    const fnName = fnMatch[1] || fnMatch[2];
                    if (/^[a-z][a-zA-Z0-9]*$/.test(fnName)) fnCasings.camelCase++;
                    else if (/^[A-Z][a-zA-Z0-9]*$/.test(fnName)) fnCasings.PascalCase++;
                    else if (fnName.includes('_')) fnCasings.snake_case++;
                }

                // Variables
                const varMatch = trimmed.match(/(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=/);
                if (varMatch) {
                    const vName = varMatch[1];
                    if (/^[a-z][a-zA-Z0-9]*$/.test(vName)) varCasings.camelCase++;
                    else if (/^[A-Z][a-zA-Z0-9]*$/.test(vName)) varCasings.PascalCase++;
                    else if (vName.includes('_')) varCasings.snake_case++;
                }

                // Interfaces
                const ifaceMatch = trimmed.match(/interface\s+([a-zA-Z0-9_]+)/);
                if (ifaceMatch) {
                    const iName = ifaceMatch[1];
                    if (/^I[A-Z]/.test(iName)) iPrefixedCount++;
                    if (/Props$/.test(iName)) propsSuffixedCount++;
                }

                // Classes
                const classMatch = trimmed.match(/class\s+([a-zA-Z0-9_]+)/);
                if (classMatch) {
                    const cName = classMatch[1];
                    if (/Service$/.test(cName)) serviceSuffixedCount++;
                    if (/Manager$/.test(cName)) managerSuffixedCount++;
                    if (/Error$/.test(cName) || trimmed.includes('extends Error')) {
                        customErrorCount++;
                        customErrorClasses.add(cName);
                    }
                }

                // Error handling detection
                if (trimmed.startsWith('try {') || trimmed.includes('try {')) tryCatchCount++;
                if (trimmed.includes('Result<') || trimmed.includes('{ success: boolean')) resultTypeCount++;

                // Component detection
                if (trimmed.includes('React.FC') || trimmed.includes('return (') || (trimmed.includes('export const ') && /^[A-Z]/.test(trimmed.split('export const ')[1] || ''))) {
                    functionalHooksCount++;
                }
                if (trimmed.includes('extends React.Component') || trimmed.includes('extends Component')) {
                    classComponentCount++;
                }
                if (trimmed.includes('@adobe/react-spectrum') || trimmed.includes('Button variant=')) spectrumUiCount++;
                if (trimmed.includes('className=') || trimmed.includes('style=')) reactDomCount++;
                if (trimmed.includes('.css') || trimmed.includes('style/')) customCssCount++;

                // State & DI detection
                if (trimmed.includes('@injectable()') || trimmed.includes('@inject(')) inversifyDiCount++;
                if (trimmed.includes('createContext') || trimmed.includes('useContext')) reactContextCount++;
                if (trimmed.includes('create(') && trimmed.includes('set =>')) zustandCount++;
                if (trimmed.includes('createSlice') || trimmed.includes('useDispatch')) reduxCount++;

                // Testing detection
                if (trimmed.includes('assert.strictEqual') || trimmed.includes('assert.ok') || trimmed.includes('assert.')) assertCount++;
                if (trimmed.includes('describe(') || trimmed.includes('expect(') || trimmed.includes('it(')) jestDescribeCount++;
            }

            // Exemplar candidate extraction
            if (content.length > 50 && content.length < 2000) {
                if (inversifyDiCount > 0 && trimmedContains(content, '@injectable()') && exemplars.length < 5) {
                    exemplars.push({
                        id: `ex-di-${file.path}`,
                        category: 'state_management',
                        title: `Inversify Dependency Injection Pattern (${path.basename(file.path)})`,
                        filePath: file.path,
                        snippet: content.slice(0, 500),
                        explanation: 'Decorate backend service classes with @injectable() and inject dependencies via constructor parameters.',
                        relevanceTags: ['inversify', 'dependency_injection', 'service']
                    });
                } else if (tryCatchCount > 0 && trimmedContains(content, 'try {') && exemplars.length < 5) {
                    exemplars.push({
                        id: `ex-err-${file.path}`,
                        category: 'error_handling',
                        title: `Structured Error Handling (${path.basename(file.path)})`,
                        filePath: file.path,
                        snippet: extractSnippetAround(content, 'try {', 12),
                        explanation: 'Wrap operations with try/catch, log diagnostic messages, and return graceful status responses.',
                        relevanceTags: ['error_handling', 'try_catch']
                    });
                } else if (file.path.includes('.test.') && assertCount > 0 && exemplars.length < 5) {
                    exemplars.push({
                        id: `ex-test-${file.path}`,
                        category: 'testing',
                        title: `Deterministic Assertion Test Suite (${path.basename(file.path)})`,
                        filePath: file.path,
                        snippet: content.slice(0, 450),
                        explanation: 'Write async unit tests using Node.js assert.strictEqual and assert.ok with descriptive failure messages.',
                        relevanceTags: ['testing', 'assert', 'unit_test']
                    });
                }
            }
        }

        // Determine dominant conventions
        const dominantVarCasing: NamingCasing = varCasings.snake_case > varCasings.camelCase ? 'snake_case' : 'camelCase';
        const dominantFnCasing: NamingCasing = fnCasings.snake_case > fnCasings.camelCase ? 'snake_case' : 'camelCase';
        const dominantFileCasing: NamingCasing = (fileCasings.PascalCase > fileCasings['kebab-case'] && fileCasings.PascalCase > fileCasings.camelCase)
            ? 'PascalCase'
            : fileCasings['kebab-case'] >= fileCasings.camelCase ? 'kebab-case' : 'camelCase';

        const naming: NamingConvention = {
            variables: dominantVarCasing,
            functions: dominantFnCasing,
            classes: 'PascalCase',
            interfaces: 'PascalCase',
            types: 'PascalCase',
            files: dominantFileCasing,
            interfaceNamingStyle: propsSuffixedCount > iPrefixedCount ? 'Props-suffixed' : iPrefixedCount > 0 ? 'I-prefixed' : 'standard',
            serviceNamingStyle: serviceSuffixedCount >= managerSuffixedCount ? 'Service-suffixed' : 'Manager-suffixed'
        };

        const primaryErrorPattern: ErrorHandlingPattern = resultTypeCount > tryCatchCount
            ? 'result-type'
            : customErrorCount > 0 ? 'custom-error-class' : 'try-catch';

        const errorHandling: ErrorHandlingConvention = {
            primaryPattern: primaryErrorPattern,
            useCustomErrorHierarchy: customErrorCount > 0,
            customErrorBaseClasses: Array.from(customErrorClasses),
            loggerPattern: 'console.error / ILogger'
        };

        const componentParadigm: ComponentParadigm = classComponentCount > functionalHooksCount
            ? 'class-component'
            : functionalHooksCount > 0 ? 'functional-hooks' : 'none';

        const component: ComponentPattern = {
            paradigm: componentParadigm,
            uiLibrary: spectrumUiCount > reactDomCount ? 'spectrum' : customCssCount > 0 ? 'custom-css' : 'react-dom',
            stateHookUsage: inversifyDiCount > reactContextCount ? 'inversify-property' : 'useState',
            propsInterfaceNaming: propsSuffixedCount > 0 ? 'PropsSuffix' : 'Standard'
        };

        const stateArch: StateManagementArchitecture = inversifyDiCount > 0
            ? 'inversify-di'
            : zustandCount > 0 ? 'zustand' : reduxCount > 0 ? 'redux' : reactContextCount > 0 ? 'react-context' : 'module-state';

        const stateManagement: StateManagementConvention = {
            architecture: stateArch,
            usesDependencyInjection: inversifyDiCount > 0,
            diFramework: inversifyDiCount > 0 ? 'inversify' : undefined
        };

        const testFramework: TestFramework = assertCount >= jestDescribeCount ? 'assert' : 'jest';
        const testStyle: TestStyle = assertCount >= jestDescribeCount ? 'assert-strict' : 'bdd-describe-it';

        const testing: TestingConvention = {
            framework: testFramework,
            style: testStyle,
            runnerCommand: 'npx ts-node <test-path>'
        };

        // Construct high-reasoning summary prompt context
        const summaryLines: string[] = [
            `[WORKSPACE_ARCHITECTURAL_CONVENTIONS: primary_lang=${Array.from(languages).join('/') || 'TypeScript'}]`,
            `• Naming: variables=${naming.variables}, functions=${naming.functions}, classes=${naming.classes}, files=${naming.files}`,
            `• Architecture & DI: ${stateManagement.architecture} (${stateManagement.usesDependencyInjection ? 'Inversify @injectable/@inject' : 'Functional'})`,
            `• Error Handling: ${errorHandling.primaryPattern} (clean try/catch with informative error messages)`,
            `• Testing: ${testing.framework} framework using ${testing.style} style`
        ];

        if (exemplars.length > 0) {
            summaryLines.push('\n### FEW-SHOT CODEBASE EXEMPLARS (ADHERE TO THESE PATTERNS):');
            for (const ex of exemplars.slice(0, 3)) {
                summaryLines.push(`--- [EXEMPLAR: ${ex.title}] ---`);
                summaryLines.push(`// Pattern Rule: ${ex.explanation}`);
                summaryLines.push(ex.snippet);
            }
        }

        const summaryPromptContext = summaryLines.join('\n');

        return {
            workspaceRoot,
            primaryLanguages: Array.from(languages),
            naming,
            errorHandling,
            component,
            stateManagement,
            testing,
            fewShotExemplars: exemplars,
            summaryPromptContext,
            analyzedFilesCount: files.length,
            lastAnalyzed: Date.now()
        };
    }

    /**
     * Synthesize a formatted few-shot pattern prompt block ready for Gemini / Deep-Write injection.
     */
    buildFewShotPatternPrompt(analysis: CodebasePatternAnalysis): string {
        return analysis.summaryPromptContext;
    }
}

function trimmedContains(str: string, target: string): boolean {
    return str.includes(target);
}

function extractSnippetAround(content: string, target: string, linesCount: number): string {
    const lines = content.split('\n');
    const idx = lines.findIndex(l => l.includes(target));
    if (idx === -1) return content.slice(0, 300);
    const start = Math.max(0, idx - 2);
    const end = Math.min(lines.length, idx + linesCount);
    return lines.slice(start, end).join('\n');
}
