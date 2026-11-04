/**
 * What a 3D scene shows while build_3d_object_from_reference is still running (scene data `objectBuildLive`): the
 * internal reference as soon as it is drawn, then each pass's real native build as soon as it exists, while that pass
 * is checked against the reference. Nothing here is simulated: the scene's object is the pass's own GLB, and the
 * finished build replaces the scene (same artifact id) without this field.
 */

export type ObjectBuildLiveStatus = 'reference' | 'checking';

export interface ObjectBuildLive {
    status: ObjectBuildLiveStatus;
    /** One line for the viewer: what is happening now. */
    message: string;
    /** The pass whose build the scene shows (1 is the first build from the reference). */
    pass?: number;
    /**
     * The reference image as a data: URL (it is never written to disk): drawn by an image model (provenance generated),
     * or, for a build from a photo, the object cut out of that photo.
     */
    referenceUri?: string;
    /** What the reference is, shown under it (absent: an internal reference drawn by an image model). */
    referenceCaption?: string;
    startedAtMs: number;
}

/** The live state of an object build in scene data, or undefined when the scene is finished (or not an object build). */
export function readObjectBuildLive(data: unknown): ObjectBuildLive | undefined {
    const live = (data as { objectBuildLive?: unknown } | null | undefined)?.objectBuildLive as Partial<ObjectBuildLive> | undefined;
    if (!live || typeof live !== 'object') return undefined;
    if (live.status !== 'reference' && live.status !== 'checking') return undefined;
    if (typeof live.message !== 'string' || typeof live.startedAtMs !== 'number') return undefined;
    return {
        status: live.status,
        message: live.message,
        startedAtMs: live.startedAtMs,
        ...(typeof live.pass === 'number' ? { pass: live.pass } : {}),
        ...(typeof live.referenceUri === 'string' ? { referenceUri: live.referenceUri } : {}),
        ...(typeof live.referenceCaption === 'string' ? { referenceCaption: live.referenceCaption } : {})
    };
}
