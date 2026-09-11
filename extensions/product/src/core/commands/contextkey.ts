/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event, IDisposable } from '../events';

export interface IContextKeyService {
    setContext(key: string, value: any): void;
    removeContext(key: string): void;
    getContext(key: string): any;
    getContextValues(): Record<string, any>;
    evaluate(expression?: string): boolean;
    readonly onDidChangeContext: Event<string[]>;
}

export class ContextKeyService implements IContextKeyService, IDisposable {
    private readonly _context = new Map<string, any>();
    private readonly _onDidChangeContext = new Emitter<string[]>();

    readonly onDidChangeContext: Event<string[]> = this._onDidChangeContext.event;

    setContext(key: string, value: any): void {
        const oldVal = this._context.get(key);
        if (oldVal !== value) {
            this._context.set(key, value);
            this._onDidChangeContext.fire([key]);
        }
    }

    setContexts(values: Record<string, any>): void {
        const changed: string[] = [];
        for (const [k, v] of Object.entries(values)) {
            if (this._context.get(k) !== v) {
                this._context.set(k, v);
                changed.push(k);
            }
        }
        if (changed.length > 0) {
            this._onDidChangeContext.fire(changed);
        }
    }

    removeContext(key: string): void {
        if (this._context.has(key)) {
            this._context.delete(key);
            this._onDidChangeContext.fire([key]);
        }
    }

    getContext(key: string): any {
        return this._context.get(key);
    }

    getContextValues(): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [k, v] of this._context.entries()) {
            result[k] = v;
        }
        return result;
    }

    evaluate(expression?: string): boolean {
        if (!expression || expression.trim() === '') {
            return true;
        }
        return this._evalExpression(expression.trim());
    }

    private _evalExpression(expr: string): boolean {
        // Disjunctions (||)
        const orClauses = expr.split(/\s+\|\|\s+/);
        if (orClauses.length > 1) {
            return orClauses.some(clause => this._evalExpression(clause));
        }

        // Conjunctions (&&)
        const andClauses = expr.split(/\s+&&\s+/);
        if (andClauses.length > 1) {
            return andClauses.every(clause => this._evalExpression(clause));
        }

        const trimmed = expr.trim();

        // Negation
        if (trimmed.startsWith('!')) {
            return !this._evalTerm(trimmed.substring(1).trim());
        }

        return this._evalTerm(trimmed);
    }

    private _evalTerm(term: string): boolean {
        // Comparison: ==
        if (term.includes('==')) {
            const [left, right] = term.split('==').map(s => s.trim());
            const leftVal = this._resolveVal(left);
            const rightVal = this._resolveVal(right);
            return leftVal == rightVal;
        }

        // Comparison: !=
        if (term.includes('!=')) {
            const [left, right] = term.split('!=').map(s => s.trim());
            const leftVal = this._resolveVal(left);
            const rightVal = this._resolveVal(right);
            return leftVal != rightVal;
        }

        // Comparison: =~ (regex match)
        if (term.includes('=~')) {
            const [left, right] = term.split('=~').map(s => s.trim());
            const leftVal = String(this._resolveVal(left));
            const regexStr = right.replace(/^\/|\/$/g, '');
            try {
                const regex = new RegExp(regexStr);
                return regex.test(leftVal);
            } catch {
                return false;
            }
        }

        // Comparison: in
        if (/\s+in\s+/.test(term)) {
            const [left, right] = term.split(/\s+in\s+/).map(s => s.trim());
            const leftVal = this._resolveVal(left);
            const rightVal = this._resolveVal(right);
            if (Array.isArray(rightVal)) {
                return rightVal.includes(leftVal);
            }
            if (typeof rightVal === 'string') {
                return rightVal.includes(String(leftVal));
            }
            return false;
        }

        // Comparison: >=, <=, >, <
        if (term.includes('>=')) {
            const [left, right] = term.split('>=').map(s => s.trim());
            return Number(this._resolveVal(left)) >= Number(this._resolveVal(right));
        }
        if (term.includes('<=')) {
            const [left, right] = term.split('<=').map(s => s.trim());
            return Number(this._resolveVal(left)) <= Number(this._resolveVal(right));
        }
        if (term.includes('>')) {
            const [left, right] = term.split('>').map(s => s.trim());
            return Number(this._resolveVal(left)) > Number(this._resolveVal(right));
        }
        if (term.includes('<')) {
            const [left, right] = term.split('<').map(s => s.trim());
            return Number(this._resolveVal(left)) < Number(this._resolveVal(right));
        }

        // Truthiness check
        const val = this._resolveVal(term);
        return Boolean(val);
    }

    private _resolveVal(identifierOrLiteral: string): any {
        const trimmed = identifierOrLiteral.trim();
        // String literal
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.slice(1, -1);
        }
        // Boolean literal
        if (trimmed === 'true') {
            return true;
        }
        if (trimmed === 'false') {
            return false;
        }
        // Number literal
        if (!isNaN(Number(trimmed)) && trimmed !== '') {
            return Number(trimmed);
        }
        // Context identifier
        return this._context.get(trimmed);
    }

    dispose(): void {
        this._onDidChangeContext.dispose();
        this._context.clear();
    }
}
