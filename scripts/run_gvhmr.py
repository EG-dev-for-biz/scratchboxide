#!/usr/bin/env python3
"""Runs GVHMR (zju3dv, SIGGRAPH Asia 2024) on a static-camera performer clip and exports the
SMPL-X body the 4DAnyone performer pipeline builds its avatar from.

Uses the GVHMR checkout and checkpoints vendored by ant-research/4DAnyone (third_party/GVHMR),
plus 4DAnyone's PyTorch3D compatibility shim, so no CUDA or compiled PyTorch3D is needed:
`.cuda()` calls are redirected to --device (mps or cpu).

Output JSON (consumed by GvhmrBodyService):
  {
    "source", "gvhmr_revision", "fps", "width", "height", "num_frames",
    "K": 3x3 hero intrinsics (pixels, OpenCV),
    "betas": [10],
    "faces": [[i, j, k]...],
    "rest_vertices": [[x, y, z]...]  # fitted shape, zero pose, Y-up, soles at y=0, facing +Z
    "rest_joints": 22 x 3,           # SMPL-X body joints of that rest body
    "skin_indices"/"skin_weights": V x 4 over the 22 body joints (hands/face folded into wrists/head)
    "hero_incam_vertices": V x 3     # frame 0 mesh in the OpenCV camera frame (x right, y down, z fwd)
    "source_world_to_camera": 4x4    # static source camera (OpenCV) in the world below
    "frames": [{"joints": 22 x 3}]   # world: gravity Y-up, source camera looks along -Z, pelvis(0) at x=z=0
    "world_from_gvhmr": 4x4          # GVHMR global (gravity) frame -> the world above
    "world_from_4danyone": 4x4       # only with --motion-dir: 4DAnyone canonical world -> the world above
  }

Usage:
  run_gvhmr.py --video clip.mp4 --out-dir out/ [--device mps] [--max-frames 121]
      [--gvhmr-root ~/dev/4DAnyone-main/third_party/GVHMR]
  run_gvhmr.py --video clip.mp4 --out-dir out/ --motion-dir data/gvhmr/results/<clip>
      # export from 4DAnyone's saved GVHMR motion so avatar and generated cameras share one fit
"""
import argparse
import contextlib
import importlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import numpy as np

HAND_FACE_TO_BODY = {22: 15, 23: 15, 24: 15}  # jaw, eyes -> head
HAND_FACE_TO_BODY.update({j: 20 for j in range(25, 40)})  # left hand -> left wrist
HAND_FACE_TO_BODY.update({j: 21 for j in range(40, 55)})  # right hand -> right wrist


def default_gvhmr_root() -> Path:
    env = os.environ.get('SCRATCHBOX_GVHMR_ROOT')
    return Path(env).expanduser() if env else Path('~/dev/4DAnyone-main/third_party/GVHMR').expanduser()


def trim_clip(video: Path, out: Path, max_frames: int) -> None:
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-frames:v', str(max_frames), '-an',
         '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', str(out)],
        check=True,
    )


def redirect_cuda(device: str) -> None:
    import torch
    target = torch.device(device)
    torch.Tensor.cuda = lambda self, *a, **k: self.to(target)
    torch.nn.Module.cuda = lambda self, *a, **k: self.to(target)
    torch.cuda.empty_cache = lambda: None
    # Lightning modules (HMR2 feature extractor) override .cuda() through their device mixin.
    from lightning_fabric.utilities.device_dtype_mixin import _DeviceDtypeModuleMixin
    _DeviceDtypeModuleMixin.cuda = lambda self, *a, **k: self.to(target)
    # MPS conv2d rejects the non-contiguous width-cropped images HMR2's ViT feeds it.
    conv_forward = torch.nn.Conv2d._conv_forward
    torch.nn.Conv2d._conv_forward = lambda self, x, w, b: conv_forward(self, x.contiguous(), w, b)

    from ultralytics import YOLO
    original_track = YOLO.track
    YOLO.track = lambda self, source=None, **cfg: original_track(self, source, **{**cfg, 'device': device})


def install_stubs() -> None:
    """GVHMR's demo imports visualization / moving-camera modules the static path never calls."""
    if importlib.util.find_spec('wis3d') is None:
        module = types.ModuleType('hmr4d.utils.wis3d_utils')
        module.make_wis3d = module.add_motion_as_lines = lambda *a, **k: None
        sys.modules[module.__name__] = module
    module = types.ModuleType('hmr4d.utils.preproc.relpose.simple_vo')
    module.SimpleVO = None
    sys.modules[module.__name__] = module


def yaw_matrix(theta: float) -> np.ndarray:
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--device', default='mps')
    parser.add_argument('--max-frames', type=int, default=121)
    parser.add_argument('--gvhmr-root', default=None)
    parser.add_argument('--motion-dir', default=None, help='4DAnyone GVHMR result dir (motion.safetensors) to export instead of inferring')
    args = parser.parse_args()
    # Resolve every path before chdir-ing into the GVHMR checkout.
    args.video = str(Path(args.video).expanduser().resolve())
    args.out_dir = str(Path(args.out_dir).expanduser().resolve())
    if args.motion_dir:
        args.motion_dir = str(Path(args.motion_dir).expanduser().resolve())

    root = (Path(args.gvhmr_root).expanduser() if args.gvhmr_root else default_gvhmr_root()).resolve()
    fdanyone_root = root.parent.parent
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    clip = out_dir / 'gvhmr_input.mp4'
    trim_clip(Path(args.video).expanduser().resolve(), clip, args.max_frames)

    os.environ['TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD'] = '1'
    sys.path.insert(0, str(fdanyone_root))
    sys.path.insert(0, str(root))
    os.chdir(root)

    from fdanyone.vendor.pytorch3d_compat import install_if_needed
    install_if_needed()
    redirect_cuda(args.device)
    install_stubs()

    import hydra
    import torch
    from hydra import compose, initialize_config_module
    from omegaconf import open_dict
    for module in ('hmr4d.model.gvhmr.gvhmr_pl_demo', 'hmr4d.model.gvhmr.utils.endecoder',
                   'hmr4d.network.gvhmr.relative_transformer'):
        importlib.import_module(module)
    from hmr4d.utils.video_io_utils import get_video_lwh

    with initialize_config_module(version_base='1.3', config_module='hmr4d.configs'):
        cfg = compose(config_name='demo', overrides=[
            f'video_name={json.dumps(clip.stem)}', 'static_cam=true', 'verbose=false', 'use_dpvo=false',
            f'output_root={json.dumps(str(out_dir / "gvhmr_work"))}',
        ])
    Path(cfg.preprocess_dir).mkdir(parents=True, exist_ok=True)
    with open_dict(cfg):
        cfg.video_path = str(clip)
    paths = cfg.paths

    length, width, height = get_video_lwh(str(clip))
    if args.motion_dir:
        pred = load_4danyone_motion(Path(args.motion_dir).expanduser().resolve())
        K = pred['K_fullimg'][0]
    else:
        pred, K = infer(cfg, paths, clip, length, width, height, args.device)
    export(args, root, fdanyone_root, cfg, clip, pred, K, length, width, height)
    return 0


def load_4danyone_motion(motion_dir: Path) -> dict:
    from safetensors.torch import load_file
    tensors = load_file(str(motion_dir / 'motion.safetensors'))
    group = lambda prefix: {k.split('.', 1)[1]: v for k, v in tensors.items() if k.startswith(prefix + '.')}
    return {'smpl_params_global': group('smpl_params_global'), 'smpl_params_incam': group('smpl_params_incam'),
            'K_fullimg': tensors['K_fullimg']}


def infer(cfg, paths, clip, length, width, height, device):
    import hydra
    import torch
    from hmr4d.utils.geo.hmr_cam import estimate_K, get_bbx_xys_from_xyxy
    from hmr4d.utils.geo_transform import compute_cam_angvel
    from hmr4d.utils.net_utils import detach_to_cpu
    from hmr4d.utils.preproc.tracker import Tracker
    from hmr4d.utils.preproc.vitfeat_extractor import Extractor
    from hmr4d.utils.preproc.vitpose import VitPoseExtractor

    if not Path(paths.bbx).exists():
        bbx_xyxy = Tracker().get_one_track(str(clip)).float()
        torch.save({'bbx_xyxy': bbx_xyxy, 'bbx_xys': get_bbx_xys_from_xyxy(bbx_xyxy, base_enlarge=1.2).float()}, paths.bbx)
    bbx_xys = torch.load(paths.bbx)['bbx_xys']
    if not Path(paths.vitpose).exists():
        torch.save(VitPoseExtractor().extract(str(clip), bbx_xys), paths.vitpose)
    if not Path(paths.vit_features).exists():
        torch.save(Extractor().extract_video_features(str(clip), bbx_xys), paths.vit_features)

    K = estimate_K(width, height)
    data = {
        'length': torch.tensor(length),
        'bbx_xys': bbx_xys,
        'kp2d': torch.load(paths.vitpose),
        'K_fullimg': K.repeat(length, 1, 1),
        'cam_angvel': compute_cam_angvel(torch.eye(3).repeat(length, 1, 1)),
        'f_imgseq': torch.load(paths.vit_features),
    }
    model = hydra.utils.instantiate(cfg.model, _recursive_=False)
    model.load_pretrained_model(cfg.ckpt_path)
    model = model.eval().to(device)
    with torch.inference_mode():
        pred = detach_to_cpu(model.predict(data, static_cam=True))
    return pred, K


def export(args, root, fdanyone_root, cfg, clip, pred, K, length, width, height):
    import torch
    from hmr4d.utils.smplx_utils import make_smplx

    smplx_model = make_smplx('supermotion')
    with torch.inference_mode():
        glob = smplx_model(**pred['smpl_params_global'])
        incam = smplx_model(**{k: v[:1] for k, v in pred['smpl_params_incam'].items()})
        betas = pred['smpl_params_global']['betas'].mean(0, keepdim=True)
        zeros = lambda n: torch.zeros(1, n)
        rest = smplx_model(betas=betas, global_orient=zeros(3), body_pose=zeros(63), transl=zeros(3))

    rest_v = rest.vertices[0].numpy().astype(np.float64)
    rest_j = rest.joints[0, :22].numpy().astype(np.float64)
    floor = rest_v[:, 1].min()
    rest_v[:, 1] -= floor
    rest_j[:, 1] -= floor

    # Skin weights: fold jaw/eyes/hand joints into the 22-joint body, keep the top 4 influences.
    inner = smplx_model.bm if hasattr(smplx_model, 'bm') else smplx_model
    lbs = inner.lbs_weights.detach().cpu().numpy()
    folded = np.zeros((lbs.shape[0], 22))
    for j in range(lbs.shape[1]):
        folded[:, HAND_FACE_TO_BODY.get(j, j) if j >= 22 else j] += lbs[:, j]
    top = np.argsort(-folded, axis=1)[:, :4]
    w = np.take_along_axis(folded, top, axis=1)
    w /= np.clip(w.sum(1, keepdims=True), 1e-8, None)

    # World: gravity-aligned GVHMR frame, yawed so the source camera looks along -Z (viewer front),
    # frame-0 pelvis at x = z = 0, floor at the median per-frame lowest vertex.
    R_g = torch_rotvec_to_matrix(pred['smpl_params_global']['global_orient'][0].numpy())
    R_c = torch_rotvec_to_matrix(pred['smpl_params_incam']['global_orient'][0].numpy())
    R_w2c = R_c @ R_g.T
    cam_fwd = R_w2c.T @ np.array([0.0, 0.0, 1.0])
    theta = np.arctan2(cam_fwd[0], cam_fwd[2]) - np.arctan2(0.0, -1.0)
    Ry = yaw_matrix(-theta)
    glob_j = glob.joints[:, :22].numpy() @ Ry.T
    glob_v_min = (glob.vertices.numpy() @ Ry.T)[:, :, 1].min(1)
    offset = np.array([glob_j[0, 0, 0], np.median(glob_v_min), glob_j[0, 0, 2]])
    glob_j = glob_j - offset
    world_from_gvhmr = np.eye(4)
    world_from_gvhmr[:3, :3] = Ry
    world_from_gvhmr[:3, 3] = -offset

    # Static source camera in the world above: rigid fit of frame-0 world vertices onto in-camera vertices.
    world_v0 = glob.vertices[0].numpy() @ Ry.T - offset
    source_world_to_camera = kabsch(world_v0, incam.vertices[0].numpy())

    faces = inner.faces if hasattr(inner, 'faces') else smplx_model.faces
    revision = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    result = {
        'source': str(Path(args.video).expanduser().resolve()),
        'gvhmr_revision': revision,
        'fps': float(cfg.get('fps', 0) or 0) or probe_fps(clip),
        'width': int(width),
        'height': int(height),
        'num_frames': int(length),
        'K': K.numpy().tolist(),
        'betas': betas[0].numpy().round(5).tolist(),
        'faces': np.asarray(faces, dtype=np.int64).tolist(),
        'rest_vertices': rest_v.round(5).tolist(),
        'rest_joints': rest_j.round(5).tolist(),
        'skin_indices': top.tolist(),
        'skin_weights': w.round(5).tolist(),
        'hero_incam_vertices': incam.vertices[0].numpy().round(5).tolist(),
        'frames': [{'joints': f.round(5).tolist()} for f in glob_j],
        'world_from_gvhmr': world_from_gvhmr.tolist(),
        'source_world_to_camera': source_world_to_camera.tolist(),
    }
    if args.motion_dir:
        result['world_from_4danyone'] = (world_from_gvhmr @ np.linalg.inv(fourdanyone_world_from_gvhmr(
            Path(args.motion_dir).expanduser().resolve(), root, fdanyone_root, args.device))).tolist()
    out_path = Path(args.out_dir).expanduser().resolve() / 'gvhmr_body.json'
    with open(out_path, 'w') as f:
        json.dump(result, f)
    print(json.dumps({'frames': int(length), 'output': str(out_path), 'device': args.device}))


def fourdanyone_world_from_gvhmr(motion_dir: Path, gvhmr_root: Path, fdanyone_root: Path, device: str) -> np.ndarray:
    """4DAnyone's own GVHMR-global -> canonical-world transform (the frame its cameras.json lives in)."""
    from fdanyone.motion.result import MotionResult
    from fdanyone.skeleton.pipeline import _body_geometry
    regressor = fdanyone_root / 'models/4danyone/smplx_to_goliath70.pt'
    geometry = _body_geometry(MotionResult.load(motion_dir), regressor, gvhmr_root, device)
    return np.asarray(geometry.motion_world_to_canonical_world, dtype=np.float64)


def kabsch(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """4x4 rigid transform T with dst ~= T @ src (least squares, no scale)."""
    cs, cd = src.mean(0), dst.mean(0)
    U, _, Vt = np.linalg.svd((src - cs).T @ (dst - cd))
    D = np.diag([1.0, 1.0, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = cd - R @ cs
    return T


def torch_rotvec_to_matrix(rv: np.ndarray) -> np.ndarray:
    theta = np.linalg.norm(rv)
    if theta < 1e-9:
        return np.eye(3)
    k = rv / theta
    Kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(theta) * Kx + (1 - np.cos(theta)) * Kx @ Kx


def probe_fps(clip: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
                          '-of', 'csv=p=0', str(clip)], capture_output=True, text=True).stdout.strip()
    num, _, den = out.partition('/')
    return float(num) / float(den or 1)


if __name__ == '__main__':
    with contextlib.suppress(BrokenPipeError):
        sys.exit(main())
