/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { Scene3DData } from '../../canvas-types';
import type { ViewportHistorySnapshot } from '../../services/viewport-history';
import { ViewportHistoryController } from './viewportHistoryController';
import type { ViewportHistoryControllerArgs } from './viewportHistoryController';

export type { HistoryEditMeta } from './viewportHistoryController';

export interface UseViewportHistoryArgs extends ViewportHistoryControllerArgs {
    sceneDataRef: { current: Scene3DData };
}

export interface ViewportHistoryApi {
    controller: ViewportHistoryController;
    snapshot: ViewportHistorySnapshot;
    undo: () => boolean;
    redo: () => boolean;
    recordSceneEdit: ViewportHistoryController['recordSceneEdit'];
    recordLiveEdit: ViewportHistoryController['recordLiveEdit'];
    recordExternalChange: ViewportHistoryController['recordExternalChange'];
}

/** One viewport timeline per mounted viewport (a different scene mounts a new viewport, so history starts empty). */
export function useViewportHistory(args: UseViewportHistoryArgs): ViewportHistoryApi {
    const argsRef = React.useRef(args);
    argsRef.current = args;
    const controller = React.useMemo(() => new ViewportHistoryController({
        commit: (update, opInfo) => argsRef.current.commit(update, opInfo),
        getSelectedId: () => argsRef.current.getSelectedId(),
        restoreSelection: id => argsRef.current.restoreSelection(id)
    }), []);
    const snapshot = React.useSyncExternalStore(controller.history.subscribe, controller.history.getSnapshot, controller.history.getSnapshot);
    React.useEffect(() => () => controller.history.clear(), [controller]);
    return {
        controller,
        snapshot,
        undo: controller.undo,
        redo: controller.redo,
        recordSceneEdit: controller.recordSceneEdit,
        recordLiveEdit: controller.recordLiveEdit,
        recordExternalChange: controller.recordExternalChange
    };
}
