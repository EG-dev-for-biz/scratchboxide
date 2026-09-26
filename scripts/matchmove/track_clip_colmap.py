#!/usr/bin/env python3
"""
Tracks the camera of a video clip with COLMAP incremental structure-from-motion (one shared camera).

Writes <out>/track.json with, per frame, the OpenCV camera pose (R, t with x_cam = R x_world + t)
and camera centre, plus the shared intrinsics, every model COLMAP produced (so breaks in the track
are visible) and reprojection statistics. The largest model is the one reported per frame.

  python scripts/matchmove/track_clip_colmap.py --frames <dir of 0001.jpg...> --out <dir>
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pycolmap


def pose_of(image):
    cfw = image.cam_from_world() if callable(image.cam_from_world) else image.cam_from_world
    R = np.asarray(cfw.rotation.matrix(), dtype=float)
    t = np.asarray(cfw.translation, dtype=float).reshape(3)
    return R, t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--stride', type=int, default=1)
    ap.add_argument('--max-image-size', type=int, default=1600)
    ap.add_argument('--max-features', type=int, default=8192)
    ap.add_argument('--camera-model', default='SIMPLE_RADIAL')
    ap.add_argument('--overlap', type=int, default=12)
    ap.add_argument('--from-sparse', action='store_true', help='Load the models already written under <out>/sparse instead of re-running COLMAP')
    args = ap.parse_args()

    frames_dir = Path(args.frames)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    all_frames = sorted(p.name for p in frames_dir.glob('*.jpg'))
    if not all_frames:
        raise SystemExit(f'No .jpg frames in {frames_dir}')
    names = all_frames[::args.stride]
    if all_frames[-1] not in names:
        names.append(all_frames[-1])

    sparse = out / 'sparse'
    if args.from_sparse:
        recs = {int(d.name): pycolmap.Reconstruction(str(d)) for d in sorted(sparse.iterdir()) if d.is_dir() and d.name.isdigit()}
    else:
        db = out / 'database.db'
        if db.exists():
            db.unlink()
        reader = pycolmap.ImageReaderOptions()
        reader.camera_model = args.camera_model
        extraction = pycolmap.FeatureExtractionOptions()
        extraction.max_image_size = args.max_image_size
        extraction.sift.max_num_features = args.max_features
        pycolmap.extract_features(db, frames_dir, image_names=names, camera_mode=pycolmap.CameraMode.SINGLE,
                                  reader_options=reader, extraction_options=extraction)

        pairing = pycolmap.SequentialPairingOptions()
        pairing.overlap = args.overlap
        pairing.quadratic_overlap = True
        pairing.loop_detection = False
        pycolmap.match_sequential(db, pairing_options=pairing)

        sparse.mkdir(exist_ok=True)
        recs = pycolmap.incremental_mapping(db, frames_dir, sparse, options=pycolmap.IncrementalPipelineOptions())
    if not recs:
        raise SystemExit('COLMAP produced no model')

    models = []
    for idx, rec in recs.items():
        frame_ids = sorted(int(Path(img.name).stem) for img in rec.images.values())
        models.append({'index': int(idx), 'registered': len(frame_ids), 'firstFrame': frame_ids[0], 'lastFrame': frame_ids[-1],
                       'points3D': int(rec.num_points3D()), 'meanReprojectionErrorPx': float(rec.compute_mean_reprojection_error())})
    best_idx = max(recs, key=lambda k: recs[k].num_reg_images())
    rec = recs[best_idx]
    (sparse / 'best').mkdir(parents=True, exist_ok=True)
    rec.write(str(sparse / 'best'))

    cam = next(iter(rec.cameras.values()))
    per_frame = {}
    for img in rec.images.values():
        R, t = pose_of(img)
        per_frame[int(Path(img.name).stem)] = {'R': R.tolist(), 't': t.tolist(), 'center': (-R.T @ t).tolist(),
                                               'numObservations': int(img.num_points3D)}

    frames = []
    for name in all_frames:
        fid = int(Path(name).stem)
        entry = {'frame': fid, 'image': name, 'registered': fid in per_frame}
        if fid in per_frame:
            entry.update(per_frame[fid])
        frames.append(entry)

    pts = np.array([p.xyz for p in rec.points3D.values()], dtype=float) if rec.num_points3D() else np.zeros((0, 3))
    cols = np.array([p.color for p in rec.points3D.values()], dtype=np.uint8) if rec.num_points3D() else np.zeros((0, 3), np.uint8)
    np.save(out / 'points3d_xyz.npy', pts)
    np.save(out / 'points3d_rgb.npy', cols)

    result = {
        'tool': f'pycolmap {pycolmap.__version__}',
        'convention': 'OpenCV camera: x right, y down, z forward; x_cam = R x_world + t (COLMAP world, arbitrary scale)',
        'camera': {'model': cam.model.name if hasattr(cam.model, 'name') else str(cam.model), 'params': list(map(float, cam.params)),
                   'width': int(cam.width), 'height': int(cam.height)},
        'models': sorted(models, key=lambda m: -m['registered']),
        'bestModel': int(best_idx),
        'framesTotal': len(all_frames),
        'framesInput': len(names),
        'framesRegistered': len(per_frame),
        'meanReprojectionErrorPx': float(rec.compute_mean_reprojection_error()),
        'frames': frames,
    }
    (out / 'track.json').write_text(json.dumps(result, indent=1))
    print(json.dumps({k: v for k, v in result.items() if k != 'frames'}, indent=1))


if __name__ == '__main__':
    main()
