/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';

/**
 * Returns a ref that always holds the latest `value`.
 *
 * Replaces the `useEffect(() => { ref.current = value; }, [value])` mirror pattern so that
 * imperative code (rAF loops, DOM listeners, three.js callbacks) can read fresh React state
 * without being listed as an effect dependency and forcing expensive re-initialisation.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
    const ref = React.useRef<T>(value);
    ref.current = value;
    return ref;
}
