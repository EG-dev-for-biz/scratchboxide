/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
