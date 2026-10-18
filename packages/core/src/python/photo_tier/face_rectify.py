"""Photo tier A of the staged-location texture pass: real Street View pixels rectified onto fitted planar faces.

Called by packages/core/src/node/3d-engine/staged-location/photo-tier-rectify.ts with one argument, a job directory holding
job.json and the raw buffers it names. Writes result.json and, per chart, `<chart>_fused.rgb` / `<chart>_mask.u8` at the
chart's output (1x) resolution. Nothing here invents a pixel: every output pixel is a real photo pixel moved by a homography.

The alignment chain (measured offline on Washington Square Arch: views agree to 2-3 px on flat faces):
  1. per pano, the WIDE view (the one that shows the facade outline) is placed in the facade frame by the plane homography of
     its pose and then aligned to the tile mesh's outline (chamfer from the outline pixels to the photo's Canny edges:
     similarity grid, then an 8-dof Nelder-Mead);
  2. the pano's NARROW views map to its wide view by a pure-rotation homography (same centre), fitted by SIFT + MAGSAC;
  3. other panos map to a reference pano by SIFT homographies between overlapping views (the facade plane induces them);
     a pano whose views do not match keeps its own outline anchor, or is not used;
  4. every view's placement is expressed as a correction of its pose in photo space, so each chart (a fitted plane, offset
     from the facade plane) gets its own plane homography from the pose: H_chart = H0_chart(pose) @ K;
  5. per chart, warps into a frontal virtual camera on the plane, spatially gated SIFT co-registration to the reference
     warp, a cross-view gradient agreement check, Lab normalisation to the reference and a per-pixel median that drops
     occluders (people, vans, trees) seen by only some views.
Texels where the tile surface leaves the fitted plane by more than the relief tolerance are not rectified (the geometry
is wrong there; a photo warped onto it would smear): their measured deviation is reported.
Direct matching of the photos to the blurry tile render is never used (it failed offline).

The held-out score (the offline experiment's score.py): one pano per facade is left out of a second fusion and placed by
the same chain; tile render, the previous ladder and photo tier A are scored against it on the same pixels.
"""
import hashlib, json, os, sys, time
import numpy as np
import cv2

RELIEF_TOL_M = 0.30          # tile surface farther than this from the fitted plane: non-planar, not rectified
OUTLINE_DEV_M = 1.0         # outline samples lie on the face itself (within this of the depth most of its surface has)
SURFACE_SLAB_M = 3.0         # tile surface within this of the facade plane belongs to the facade (outline extraction)
ALIGN_MAX_PX = 10.0          # outline chamfer (facade frame px) above which a wide view is not an anchor
ROT_MIN_INLIERS = 60         # narrow -> wide (same pano) homography
XPANO_MIN_INLIERS = 40       # view -> reference view (other pano) homography
COREG_MIN_INLIERS = 30
SIDE_WEIGHT_PX = 4.0         # the outline's two-sided contrast is worth up to this much chamfer (facade frame px)
AGREE_ANCHOR_PX = 10.0       # two panos' outline anchors agree within this (facade frame px, 20 cm at 50 px/m)
AGREE_NCC = 0.25             # gradient NCC of a view against the reference warp to be fused
DEV_LAB = 20.0               # per-pixel Lab deviation from the median beyond which a view's pixel is an outlier
MIN_OVERLAP_PX = 2000


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- cameras (FrameCamera of StreetViewPoseRegistrar.ts)
def cam_project(cam, P):
    """World points -> OpenCV pixel coordinates (pixel centres at integers) and z-depth."""
    P = np.atleast_2d(P).astype(np.float64); d = P - np.asarray(cam['eye'])
    zc = d @ np.asarray(cam['fwd']); xc = d @ np.asarray(cam['right']); yc = d @ np.asarray(cam['up'])
    zs = np.where(np.abs(zc) < 1e-9, 1e-9, zc)
    return np.stack([cam['cx'] + cam['fx'] * xc / zs - 0.5, cam['cy'] - cam['fy'] * yc / zs - 0.5], 1), zc


def cam_rays(cam, px):
    px = np.atleast_2d(px).astype(np.float64)
    xc = (px[:, 0] + 0.5 - cam['cx']) / cam['fx']; yc = -(px[:, 1] + 0.5 - cam['cy']) / cam['fy']
    d = np.asarray(cam['fwd'])[None] + xc[:, None] * np.asarray(cam['right'])[None] + yc[:, None] * np.asarray(cam['up'])[None]
    return np.asarray(cam['eye'], np.float64), d


def plane_hit(cam, px, plane):
    e, d = cam_rays(cam, px); n = np.asarray(plane['normal'], np.float64); p0 = np.asarray(plane['point'], np.float64)
    s = ((p0 - e) @ n) / (d @ n)
    return e[None] + s[:, None] * d, s


def plane_homography(photo_cam, frame_cam, W, H, plane):
    """Photo pixel -> frame pixel homography induced by the plane (None when the plane is behind the photo camera)."""
    grid = np.array([[x, y] for x in np.linspace(0, W - 1, 5) for y in np.linspace(0, H - 1, 5)])
    P, _ = plane_hit(frame_cam, grid, plane)
    q, z = cam_project(photo_cam, P)
    if (z <= 0.5).any():
        return None
    Hm, _ = cv2.findHomography(q.astype(np.float32), grid.astype(np.float32), 0)
    return Hm


def plane_depth_and_dev(cam, W, H, plane, depth):
    """Per frame pixel: signed distance (m) of the tile surface in front of the plane (nan where no surface)."""
    ys, xs = np.mgrid[0:H, 0:W]; px = np.stack([xs.ravel(), ys.ravel()], 1)
    e, d = cam_rays(cam, px); n = np.asarray(plane['normal'], np.float64); p0 = np.asarray(plane['point'], np.float64)
    s = ((p0 - e) @ n) / (d @ n)           # z-depth of the plane (rays have unit fwd component)
    cosn = np.abs(d @ n) / np.linalg.norm(d, axis=1)
    z = depth.ravel().astype(np.float64)
    dev = np.where(z < 1e8, (s - z) * np.linalg.norm(d, axis=1) * cosn, np.nan)
    return dev.reshape(H, W), s.reshape(H, W)


# ---------------------------------------------------------------- image helpers
def gray(img): return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
def clahe(g): return cv2.createCLAHE(3.0, (8, 8)).apply(g)


def grad(g, s):
    b = cv2.GaussianBlur(g.astype(np.float32), (0, 0), s); gx = cv2.Sobel(b, cv2.CV_32F, 1, 0); gy = cv2.Sobel(b, cv2.CV_32F, 0, 1)
    return np.sqrt(gx * gx + gy * gy)


def ncc(a, b, m):
    a = a[m].astype(np.float64); b = b[m].astype(np.float64)
    if a.size < 100: return None
    a = a - a.mean(); b = b - b.mean(); return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


_sift = None
def sift():
    global _sift
    if _sift is None: _sift = cv2.SIFT_create(8000)
    return _sift


def feats(img, mask=None):
    return sift().detectAndCompute(clahe(gray(img)), mask)


def match_h(fa, fb, thr, gate=None, ratio=0.8):
    """Homography a -> b from SIFT features (ratio test, MAGSAC). gate: max displacement px (spatially gated)."""
    ka, da = fa; kb, db = fb
    if da is None or db is None or len(ka) < 12 or len(kb) < 12: return None, 0, None
    fl = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    m = fl.knnMatch(da, db, k=2)
    good = [p[0] for p in m if len(p) == 2 and p[0].distance < ratio * p[1].distance]
    if gate is not None:
        good = [g for g in good if np.hypot(*(np.array(ka[g.queryIdx].pt) - np.array(kb[g.trainIdx].pt))) < gate]
    if len(good) < 12: return None, len(good), None
    src = np.float32([ka[g.queryIdx].pt for g in good]); dst = np.float32([kb[g.trainIdx].pt for g in good])
    Hm, inl = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, thr, maxIters=10000, confidence=0.999)
    if Hm is None or inl is None: return None, 0, None
    k = inl.ravel() > 0; n = int(k.sum())
    res = float(np.median(np.linalg.norm(cv2.perspectiveTransform(src[k][None], Hm)[0] - dst[k], axis=1))) if n else None
    return Hm, n, res


def on_facade(feat, Hm, mask):
    """The features of a photo whose pixels the placement `Hm` (photo -> facade frame) puts on the facade mask: a wide view
    also shows trees, the park and buildings far behind, whose matches would fit a homography that is not the facade's."""
    k, d = feat
    if d is None or not len(k): return feat
    pts = np.float32([p.pt for p in k])[None]
    q = cv2.perspectiveTransform(pts, Hm)[0]
    H, W = mask.shape
    x = np.round(q[:, 0]).astype(int); y = np.round(q[:, 1]).astype(int)
    ok = (x >= 0) & (y >= 0) & (x < W) & (y < H)
    ok[ok] = mask[y[ok], x[ok]]
    idx = np.nonzero(ok)[0]
    return [k[i] for i in idx], d[idx]


def nelder_mead(f, x0, step, iters=250):
    n_ = len(x0); pts = [x0] + [x0 + np.eye(n_)[i] * step for i in range(n_)]; vals = [f(q) for q in pts]
    for _ in range(iters):
        o = np.argsort(vals); pts = [pts[i] for i in o]; vals = [vals[i] for i in o]
        c = np.mean(pts[:-1], 0); xr = 2 * c - pts[-1]; fr = f(xr)
        if fr < vals[0]:
            xe = 3 * c - 2 * pts[-1]; fe = f(xe); pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]: pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c); fc = f(xc)
            if fc < vals[-1]: pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (q - pts[0]) for q in pts[1:]]; vals = [vals[0]] + [f(q) for q in pts[1:]]
    i = int(np.argmin(vals)); return pts[i], vals[i]


# ---------------------------------------------------------------- outline alignment of a wide view (face_align.py)
def outline_points(fr):
    """Facade-frame pixels of the tile outline: surface pixels next to non-surface, on the largest surface component."""
    surf = np.abs(np.nan_to_num(fr['dev'], nan=1e9)) <= SURFACE_SLAB_M
    if surf.sum() < 500: return None, None
    n, lab = cv2.connectedComponents(surf.astype(np.uint8))
    if n < 2: return None, None
    big = 1 + int(np.argmax(np.bincount(lab.ravel())[1:]))
    sil = surf & (cv2.dilate((~surf).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & (lab == big)
    # only the face's own outline: the edge of ground or of a deep return in the slab is not an edge the photos show
    # (the face's front lies where most of its surface does, which need not be the mean plane of its charts; samples at the
    # slab's own cut are not edges either)
    dv = np.nan_to_num(fr['dev'], nan=1e9); front = float(np.median(dv[surf]))
    sil &= (np.abs(dv - front) <= OUTLINE_DEV_M) & (np.abs(dv) < SURFACE_SLAB_M - 0.3)
    sil[:2] = sil[-2:] = False; sil[:, :2] = sil[:, -2:] = False
    sy, sx = np.nonzero(sil)
    if sy.size < 80: return None, None
    if sy.size > 4000:
        k = np.random.default_rng(0).choice(sy.size, 4000, replace=False); sy, sx = sy[k], sx[k]
    # the outline lies between a surface pixel and its empty neighbour: move each sample half a pixel outward
    m = cv2.GaussianBlur(surf.astype(np.float32), (0, 0), 1.0)
    gx = cv2.Sobel(m, cv2.CV_32F, 1, 0)[sy, sx]; gy = cv2.Sobel(m, cv2.CV_32F, 0, 1)[sy, sx]
    gl = np.hypot(gx, gy) + 1e-9
    nout = np.stack([-gx / gl, -gy / gl], 0).astype(np.float64)   # outward unit normal (toward what is not the face)
    return np.stack([sx - 0.5 * gx / gl, sy - 0.5 * gy / gl, np.ones(sx.size)], 0).astype(np.float64), nout


def outline_fraction(H0, spts, w, h):
    if H0 is None: return 0.0
    q = np.linalg.inv(H0) @ spts; z = q[2]; u = q[0] / z; v = q[1] / z
    return float(((z > 0) & (u >= 0) & (v >= 0) & (u < w - 1) & (v < h - 1)).mean())


def align_outline(img, H0, spts, W, H, nout=None):
    pe = cv2.Canny(cv2.GaussianBlur(gray(img), (0, 0), 1.5), 40, 120)
    # two-sided term: across the true outline the photo changes from the face to what is not the face (sky, trees, the
    # buildings behind); across a course joint or a moulding parallel to it, stone meets stone. Samples 3 facade-frame px out
    # and in along the outline's normal; the Lab difference (capped) is a bonus of up to SIDE_WEIGHT_PX.
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (0, 0), 2.0), cv2.COLOR_BGR2LAB).astype(np.float32)
    if nout is not None:
        pout = spts.copy(); pin = spts.copy()
        pout[:2] += 3 * nout; pin[:2] -= 3 * nout
    dtp = cv2.distanceTransform((pe == 0).astype(np.uint8), cv2.DIST_L2, 3)
    h, w = dtp.shape

    def inside(Hm):
        q = np.linalg.inv(Hm) @ spts; z = q[2]
        u = q[0] / np.where(z > 0, z, 1); v = q[1] / np.where(z > 0, z, 1)
        return (z > 0) & (u >= 0) & (v >= 0) & (u < w - 1) & (v < h - 1), u, v
    # the outline samples the pose puts in the photo are scored throughout: one pushed out of the frame costs the cap (a
    # placement must not win by dropping the outline it cannot explain)
    base, _, _ = inside(H0)
    if base.mean() < 0.5: base = np.ones_like(base)

    def side(Hm):
        if nout is None: return 0.0
        hi = np.linalg.inv(Hm)
        def samp(P):
            q = hi @ P; z = q[2]; u = q[0] / np.where(z > 0, z, 1); v = q[1] / np.where(z > 0, z, 1)
            okk = (z > 0) & (u >= 0) & (v >= 0) & (u < w - 1) & (v < h - 1)
            return okk, lab[np.clip(v, 0, h - 1).astype(int), np.clip(u, 0, w - 1).astype(int)]
        oa, la = samp(pout); ob, lb = samp(pin); m = oa & ob & base
        if m.sum() < 20: return 0.0
        return float(np.mean(np.minimum(np.linalg.norm(la[m] - lb[m], axis=1), 40.0)) / 40.0)

    def cost(Hm):
        c = chamfer(Hm)
        return c if c >= 99 else c + SIDE_WEIGHT_PX * (1.0 - side(Hm))

    def chamfer(Hm, cap=30.0):
        ok, u, v = inside(Hm)
        if ok[base].mean() < 0.5: return 99.0
        sc = np.sqrt(abs(np.linalg.det(Hm[:2, :2] / Hm[2, 2])))
        m = ok & base
        u, v = u[m], v[m]; x0 = u.astype(int); y0 = v.astype(int); tx = u - x0; ty = v - y0
        d = (dtp[y0, x0] * (1 - tx) * (1 - ty) + dtp[y0, x0 + 1] * tx * (1 - ty) + dtp[y0 + 1, x0] * (1 - tx) * ty + dtp[y0 + 1, x0 + 1] * tx * ty)
        return float((np.minimum(d * sc, cap).sum() + cap * (base & ~ok).sum()) / base.sum())

    c0 = chamfer(H0); best = (cost(H0), H0)
    C = np.array([[1, 0, W / 2], [0, 1, H / 2], [0, 0, 1.0]]); Ci = np.linalg.inv(C)
    span = int(max(40, min(140, 0.08 * max(W, H))))
    stp = max(6, span // 8)
    for s in np.linspace(0.88, 1.14, 7):
        for r in (-1.5, 0.0, 1.5):
            a = np.radians(r)
            for ty in range(-span, span + 1, stp):
                for tx in range(-span, span + 1, stp):
                    S = np.array([[s * np.cos(a), -s * np.sin(a), tx], [s * np.sin(a), s * np.cos(a), ty], [0, 0, 1]])
                    Hm = C @ S @ Ci @ H0; c = cost(Hm)
                    if c < best[0]: best = (c, Hm)
    Nrm = np.diag([1 / W, 1 / H, 1.0])
    G = best[1] / best[1][2, 2]
    x0 = Nrm @ G @ np.linalg.inv(Nrm); x0 = (x0 / x0[2, 2]).ravel()[:8]
    xb, fb = nelder_mead(lambda v: cost(np.linalg.inv(Nrm) @ np.append(v, 1).reshape(3, 3) @ Nrm), x0, 0.004)
    Gf = np.linalg.inv(Nrm) @ np.append(xb, 1).reshape(3, 3) @ Nrm
    return Gf, {'chamferPosePx': round(c0, 2), 'chamferGridPx': round(chamfer(best[1]), 2), 'chamferPx': round(chamfer(Gf), 2),
                'sideContrastPose': round(side(H0), 3), 'sideContrast': round(side(Gf), 3)}


def homography_disagreement(Ga, Gb, spts):
    """Median facade-frame distance (px) between two placements of the same photo, over the outline points."""
    q = np.linalg.inv(Ga) @ spts
    r = Gb @ q
    a = spts[:2] / spts[2]; b = r[:2] / r[2]
    return float(np.median(np.linalg.norm(a - b, axis=0)))


def consensus_reference(G, wide, rep, spts, F, H0, fmask, agree_px=AGREE_ANCHOR_PX):
    pids = list(G)
    out = {'pairs': [], 'agreeing': {}}
    if len(pids) == 1:
        out['note'] = 'a single outline anchor (nothing to check it against)'
        return pids[0], out
    S = {}
    for i, p in enumerate(pids):
        for q in pids[i + 1:]:
            Hs, n, res = match_h(on_facade(F(wide[q]), G[q], fmask), on_facade(F(wide[p]), G[p], fmask), 4.0)   # photo q -> photo p
            if Hs is None or n < XPANO_MIN_INLIERS: continue
            S[(q, p)] = Hs; S[(p, q)] = np.linalg.inv(Hs)
            d = homography_disagreement(G[q], G[p] @ Hs, spts)
            out['pairs'].append([p, q, n, round(d, 2)])
    agree = {p: [q for q in pids if q != p and (q, p) in S and homography_disagreement(G[q], G[p] @ S[(q, p)], spts) <= agree_px] for p in pids}
    checked = {p: [q for q in pids if q != p and (q, p) in S] for p in pids}
    out['agreeing'] = {p: len(v) for p, v in agree.items()}
    # most agreeing panos first; between equal groups, the lower mean outline chamfer of the group
    ref = max(pids, key=lambda p: (len(agree[p]), -np.mean([rep['panos'][q]['chamferPx'] for q in [p] + agree[p]])))
    if agree[ref]:
        # the reference placement: per outline point, the median of its own anchor and the agreeing panos' anchors carried over
        cands = [G[ref]] + [G[q] @ S[(ref, q)] for q in agree[ref]]
        q0 = np.linalg.inv(G[ref]) @ spts
        pts = np.stack([(Gc @ q0)[:2] / (Gc @ q0)[2] for Gc in cands])
        med = np.median(pts, axis=0)
        src = (q0[:2] / q0[2]).T.astype(np.float32)
        Hm, _ = cv2.findHomography(src, med.T.astype(np.float32), 0)
        if Hm is not None:
            G[ref] = Hm
        out['refinedFrom'] = len(cands)
    else:
        out['note'] = 'no two outline anchors agree; the best outline chamfer is the reference'
    for p in pids:
        if p != ref and p in checked[ref] and p not in agree[ref]:
            rep['panos'][p]['anchorDisagrees'] = True
    return ref, out


# ---------------------------------------------------------------- loading
def load_job(d):
    job = json.load(open(os.path.join(d, 'job.json')))
    views = {}
    for v in job['views']:
        raw = np.fromfile(os.path.join(d, v['file']), np.uint8).reshape(v['height'], v['width'], 4)
        views[v['key']] = {**v, 'img': cv2.cvtColor(raw, cv2.COLOR_RGBA2BGR), 'sha': hashlib.sha1(raw.tobytes()).hexdigest()}
    return job, views


class DiskCache:
    """Per-run cache of what does not depend on the other panos (a wide view's outline anchor, a photo's SIFT features), so
    the leave-one-pano-out re-runs of the same layer do not redo it. Off when the job names no directory."""
    def __init__(self, d):
        self.d = d
        if d: os.makedirs(d, exist_ok=True)

    def anchor(self, key, compute):
        if not self.d: return compute()
        p = os.path.join(self.d, f'anchor_{key}.json')
        if os.path.exists(p):
            j = json.load(open(p)); return np.array(j['G']), j['info']
        G, info = compute()
        json.dump({'G': G.tolist(), 'info': info}, open(p, 'w'))
        return G, info

    def feats(self, sha, img):
        if not self.d: return feats(img)
        p = os.path.join(self.d, f'sift_{sha}.npz')
        if os.path.exists(p):
            z = np.load(p)
            k = [cv2.KeyPoint(float(a[0]), float(a[1]), float(a[2]), float(a[3]), float(a[4]), int(a[5]), int(a[6])) for a in z['k']]
            return k, (z['d'] if len(k) else None)
        k, dsc = feats(img)
        np.savez(p, k=np.array([[q.pt[0], q.pt[1], q.size, q.angle, q.response, q.octave, q.class_id] for q in k], np.float64).reshape(-1, 7), d=dsc if dsc is not None else np.zeros((0, 128), np.float32))
        return k, dsc


CACHE = DiskCache(None)
ANCHOR_TO_OUTLINE = True


def load_frame(d, fr):
    depth = np.fromfile(os.path.join(d, fr['depth']), np.float32).reshape(fr['H'], fr['W'])
    dev, zplane = plane_depth_and_dev(fr['cam'], fr['W'], fr['H'], fr['plane'], depth)
    return {**fr, 'depthArr': depth, 'dev': dev}


# ---------------------------------------------------------------- placement of the views on one facade
def place_facade(fac, views, d, feat_cache):
    t0 = time.time()
    fr = load_frame(d, fac['frame']); W, H = fr['W'], fr['H']
    keys = [k for k in fac['views'] if k in views]
    H0 = {k: plane_homography(views[k]['cam'], fr['cam'], W, H, fr['plane']) for k in keys}
    keys = [k for k in keys if H0[k] is not None]
    spts, nout = outline_points(fr)
    rep = {'id': fac['id'], 'panos': {}, 'views': {}, 'outlinePixels': 0 if spts is None else int(spts.shape[1])}
    if spts is None:
        rep['skipped'] = 'the tile mesh shows no outline of this facade in the facade frame'
        return None, rep
    panos = {}
    for k in keys: panos.setdefault(views[k]['panoId'], []).append(k)
    if not ANCHOR_TO_OUTLINE:
        # diagnostic: every view at its registered pose (no outline anchor, no cross-pano homography); the chart fusion still
        # co-registers to the reference warp and votes per pano
        ref = max(panos, key=lambda p: len(panos[p]))
        rep['reference'] = ref
        for k in keys: rep['views'][k] = {'placement': 'registered pose'}
        rep['seconds'] = round(time.time() - t0, 2)
        return {'K': {k: np.eye(3) for k in keys}, 'ref': ref, 'placed': {k: (H0[k], rep['views'][k]) for k in keys}, 'panos': panos}, rep
    # 1. wide view per pano and its outline anchor
    G, wide = {}, {}
    for pid, ks in panos.items():
        fracs = {k: outline_fraction(H0[k], spts, views[k]['width'], views[k]['height']) for k in ks}
        kw = max(ks, key=lambda k: fracs[k])
        pr = {'views': len(ks), 'wideOutlineFraction': round(fracs[kw], 3)}
        if fracs[kw] >= 0.5:
            akey = hashlib.sha1(b'anchor-v2' + views[kw]['sha'].encode() + np.round(H0[kw], 6).tobytes() + np.round(spts, 3).tobytes()).hexdigest()
            Gw, info = CACHE.anchor(akey, lambda: align_outline(views[kw]['img'], H0[kw], spts, W, H, nout)); pr.update(info)
            if info['chamferPx'] <= ALIGN_MAX_PX and info['chamferPx'] <= info['chamferPosePx'] + 0.5:
                G[pid] = Gw; wide[pid] = kw; pr['anchor'] = 'outline'
            else:
                pr['anchor'] = None; pr['anchorRejected'] = f"outline chamfer {info['chamferPx']:.1f} px (pose {info['chamferPosePx']:.1f} px)"
        else:
            pr['anchor'] = None; pr['anchorRejected'] = f"no view shows the outline (best {fracs[kw]:.0%} of it in frame)"
        rep['panos'][pid] = pr
    if not G:
        rep['skipped'] = 'no pano has a wide view aligned to the tile outline'
        return None, rep
    F = lambda k: feat_cache[k] if k in feat_cache else feat_cache.setdefault(k, CACHE.feats(views[k]['sha'], views[k]['img']))
    # consensus of the outline anchors: a wide view can lock onto a repeated course instead of the outline (a coursed wall
    # is full of edges parallel to it), each pano at a different offset; panos whose anchors agree through feature
    # homographies between their wide views are right together. The reference is the pano most others agree with.
    surf = np.abs(np.nan_to_num(fr['dev'], nan=1e9)) <= SURFACE_SLAB_M
    fmask = cv2.dilate(surf.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
    ref, consensus = consensus_reference(G, wide, rep, spts, F, H0, fmask)
    rep['reference'] = ref; rep['consensus'] = consensus
    # 2. own chains: wide view and the narrow views by pure rotation
    own = {}
    for pid, kw in wide.items():
        own[kw] = (G[pid], {'placement': 'outline anchor (wide view)'})
        for k in panos[pid]:
            if k == kw: continue
            Hr, n, res = match_h(F(k), F(kw), 3.0)
            if Hr is not None and n >= ROT_MIN_INLIERS:
                own[k] = (G[pid] @ Hr, {'placement': 'rotation to its wide view', 'inliers': n, 'residualPx': None if res is None else round(res, 2)})
            else:
                rep['views'][k] = {'placement': None, 'reason': f'rotation to its own wide view: {n} inliers'}
    # 3. views of other panos: SIFT to the reference pano's placed views (overlapping footprints)
    A = {}
    refks = [k for k in panos[ref] if k in own]
    for k in refks: A[k] = own[k]
    def footprint(Hm, w, h):
        c = cv2.perspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]])[None], Hm)[0]
        return c
    def overlap(Ha, va, Hb, vb):
        ca = footprint(Ha, va['width'], va['height']); cb = footprint(Hb, vb['width'], vb['height'])
        try:
            r, _ = cv2.intersectConvexConvex(ca.astype(np.float32), cb.astype(np.float32))
        except cv2.error:
            return 0.0
        return float(r) / max(1.0, min(abs(cv2.contourArea(ca)), abs(cv2.contourArea(cb))))
    for pid, ks in panos.items():
        if pid == ref: continue
        for k in ks:
            cands = sorted(refks, key=lambda r: -overlap(H0[k], views[k], A[r][0], views[r]))
            best = (None, 0, None, None)
            for r in cands[:3]:
                if overlap(H0[k], views[k], A[r][0], views[r]) < 0.1: continue
                Hs, n, res = match_h(on_facade(F(k), H0[k], cv2.dilate(fmask.astype(np.uint8), np.ones((61, 61), np.uint8)) > 0), on_facade(F(r), A[r][0], fmask), 4.0)
                if Hs is not None and n > best[1]: best = (Hs, n, res, r)
            if best[0] is not None and best[1] >= XPANO_MIN_INLIERS:
                A[k] = (A[best[3]][0] @ best[0], {'placement': 'feature homography to the reference pano', 'inliers': best[1], 'residualPx': None if best[2] is None else round(best[2], 2), 'to': best[3]})
            elif k in own:
                A[k] = (own[k][0], {**own[k][1], 'flag': f'own anchor: SIFT to the reference pano only {best[1]} inliers'})
            else:
                rep['views'].setdefault(k, {'placement': None, 'reason': f'SIFT to the reference pano only {best[1]} inliers and no outline anchor of its own'})
    for k, (Am, info) in A.items():
        rep['views'][k] = info
    # 4. corrections in photo space
    K = {k: np.linalg.inv(H0[k]) @ Am for k, (Am, _) in A.items()}
    rep['seconds'] = round(time.time() - t0, 2)
    return {'K': K, 'ref': ref, 'placed': A, 'panos': panos}, rep


# ---------------------------------------------------------------- fusion on one chart
def warp_views(ch, views, placement, keys):
    fr = ch['fr']; W, H = fr['W'], fr['H']; out = {}
    M = ch['region']
    for k in keys:
        if k not in placement['K']: continue
        H0 = plane_homography(views[k]['cam'], fr['cam'], W, H, fr['plane'])
        if H0 is None: continue
        Hc = H0 @ placement['K'][k]
        img = views[k]['img']
        w = cv2.warpPerspective(img, Hc, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        v = cv2.warpPerspective(np.full(img.shape[:2], 255, np.uint8), Hc, (W, H), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT) > 0
        v = cv2.erode(v.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        v &= M
        if v.sum() < max(200, 0.02 * M.sum()): continue
        out[k] = [w, v, Hc]
    return out


def fuse(ch, warped, views, ref_pano, info):
    """Per-pixel median fusion with a cross-view agreement check. Returns (fused BGR, nAgree, used keys)."""
    M = ch['region']
    if not warped: return None, None, []
    order = sorted(warped, key=lambda k: (views[k]['panoId'] != ref_pano, -int(warped[k][1].sum())))
    ref = order[0]
    W_, H_ = ch['fr']['W'], ch['fr']['H']
    # spatially gated co-registration to the reference warp (chart frame)
    if min(W_, H_) >= 120 and len(order) > 1:
        fr_ = feats(warped[ref][0], (warped[ref][1]).astype(np.uint8) * 255)
        for k in order[1:]:
            fk = feats(warped[k][0], warped[k][1].astype(np.uint8) * 255)
            Hm, n, res = match_h(fk, fr_, 3.0, gate=40)
            rec = info.setdefault(k, {}); rec.setdefault('coreg', []).append(n)
            if Hm is not None and n >= COREG_MIN_INLIERS:
                w, v, _ = warped[k]
                warped[k][0] = cv2.warpPerspective(w, Hm, (W_, H_), flags=cv2.INTER_LINEAR)
                warped[k][1] = (cv2.warpPerspective(v.astype(np.uint8), Hm, (W_, H_), flags=cv2.INTER_NEAREST) > 0) & M
    gref = grad(gray(warped[ref][0]), 2.0)
    use = [ref]
    for k in order[1:]:
        m = warped[k][1] & warped[ref][1]
        if m.sum() < MIN_OVERLAP_PX:
            use.append(k); info.setdefault(k, {})['agreement'] = 'unchecked (little overlap with the reference)'; continue
        c = ncc(grad(gray(warped[k][0]), 2.0), gref, m)
        info.setdefault(k, {})['gradNccToRef'] = None if c is None else round(c, 3)
        if c is not None and c > AGREE_NCC: use.append(k)
    lab = {k: cv2.cvtColor(warped[k][0], cv2.COLOR_BGR2LAB).astype(np.float32) for k in use}
    refV = warped[ref][1]
    for k in use[1:]:
        m = warped[k][1] & refV
        if m.sum() > 1000:
            for c in range(3):
                a_, b_ = lab[k][..., c][m], lab[ref][..., c][m]
                lab[k][..., c] = (lab[k][..., c] - a_.mean()) * (b_.std() / (a_.std() + 1e-6)) + b_.mean()
    Ls = np.stack([lab[k] for k in use]); Vs = np.stack([warped[k][1] for k in use])
    # the median votes per PANO: a pano's views share its eye, so a van in front of it is in all of them
    pids = [views[k]['panoId'] for k in use]
    with np.errstate(all='ignore'):
        per = np.stack([np.nanmean(np.where(Vs[[i for i, p in enumerate(pids) if p == q]][..., None], Ls[[i for i, p in enumerate(pids) if p == q]], np.nan), axis=0) for q in dict.fromkeys(pids)])
        med = np.nanmedian(per, axis=0)
    npano = np.isfinite(per[..., 0]).sum(0)
    # a view's pixel is an outlier where it leaves the median by DEV_LAB, and so is a margin around it (an occluder's soft
    # edge must not survive into the blend)
    dev = np.stack([cv2.GaussianBlur(np.linalg.norm(np.nan_to_num(L - med), axis=2), (0, 0), 1.5) for L in Ls])
    bad = np.stack([cv2.dilate((d_ >= DEV_LAB).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0 for d_ in dev])
    ok = Vs & (~bad | (npano[None] < 3))
    good = Vs & ~bad
    agree = np.stack([good[[i for i, p in enumerate(pids) if p == q]].any(0) for q in dict.fromkeys(pids)]).sum(0)   # agreeing panos
    wts = np.stack([cv2.GaussianBlur(ok[i].astype(np.float32), (0, 0), 6) * ok[i] * (0.4 ** i) for i in range(len(use))]) ** 2
    sw = wts.sum(0) + 1e-12
    fused = cv2.cvtColor((np.einsum('khwc,khw->hwc', Ls, wts) / sw[..., None]).clip(0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    cov = ok.any(0)
    fused[~cov] = 0
    nag = np.where(cov, np.maximum(1, agree), 0).astype(np.uint8)
    return fused, nag, use


def down2(img):
    return cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------- held-out score (score.py)
def canny_edges(img, valid, sigma=2.0):
    g = cv2.GaussianBlur(gray(img), (0, 0), sigma); med = np.median(g[valid]) if valid.any() else 128
    e = cv2.Canny(g, int(max(10, 0.33 * med * 0.5)), int(min(255, 0.66 * med * 0.6 + 30))) > 0
    gm = grad(gray(img), sigma); thr = np.quantile(gm[valid], 0.80) if valid.sum() > 100 else 1e9
    return e & (gm > thr) & valid


def geometry_edges(cam, depth, region, depth_jump=0.25, crease_deg=35):
    H, W = depth.shape; d = depth.astype(np.float64); bg = d > 1e8
    ys, xs = np.mgrid[0:H, 0:W]; e, r = cam_rays(cam, np.stack([xs.ravel(), ys.ravel()], 1))
    P = (e[None] + np.where(bg.ravel(), 0, d.ravel())[:, None] * r).reshape(H, W, 3)
    dx = np.zeros_like(d); dy = np.zeros_like(d)
    dd = np.where(bg, 1e3, d)
    dx[:, 1:] = np.abs(dd[:, 1:] - dd[:, :-1]); dy[1:, :] = np.abs(dd[1:, :] - dd[:-1, :])
    jump = (dx > depth_jump) | (dy > depth_jump)
    k = 2; tx = np.zeros_like(P); ty = np.zeros_like(P)
    tx[:, k:-k] = P[:, 2 * k:] - P[:, :-2 * k]; ty[k:-k, :] = P[2 * k:, :] - P[:-2 * k, :]
    nrm = np.cross(tx, ty); nrm /= (np.linalg.norm(nrm, axis=2, keepdims=True) + 1e-12)
    ang = lambda a, b: np.degrees(np.arccos(np.clip((a * b).sum(-1), -1, 1)))
    cr = np.zeros((H, W), bool); s = 2
    cr[:, s:-s] |= ang(nrm[:, 2 * s:], nrm[:, :-2 * s]) > crease_deg
    cr[s:-s, :] |= ang(nrm[2 * s:, :], nrm[:-2 * s, :]) > crease_deg
    cr &= ~jump & ~bg
    Md = cv2.dilate(region.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    Me = cv2.erode(region.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    out = (jump & Md & ~(cv2.erode(Md.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0)) | (cr & Me)
    out[:2] = out[-2:] = False; out[:, :2] = out[:, -2:] = False
    return out


def srgb_to_lab(img):
    x = img[..., ::-1].astype(np.float64) / 255.0; x = np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)
    Mx = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]); xyz = x @ Mx.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def de2000(l1, l2):
    L1, a1, b1 = l1[..., 0], l1[..., 1], l1[..., 2]; L2, a2, b2 = l2[..., 0], l2[..., 1], l2[..., 2]
    C1 = np.hypot(a1, b1); C2 = np.hypot(a2, b2); Cb = (C1 + C2) / 2; G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2; C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360; h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1; dCp = C2p - C1p; dh = h2p - h1p; dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh)); dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2)); Lbp = (L1 + L2) / 2; Cbp = (C1p + C2p) / 2
    hs = h1p + h2p; hbp = np.where(C1p * C2p == 0, hs, np.where(np.abs(h1p - h2p) > 180, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2), hs / 2))
    Tt = 1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp)) + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63))
    SL = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2); SC = 1 + 0.045 * Cbp; SH = 1 + 0.015 * Cbp * Tt
    RT = -2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-((hbp - 275) / 25) ** 2)))
    return np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH))


class Scorer:
    """Accumulates score.py's measures over the charts of a layer (pixel-weighted / pooled)."""
    def __init__(self):
        self.items = []

    def add(self, methods, heldout, hvalid, sources, geo, common):
        if common.sum() < 400: return
        hov = hvalid & common
        real = canny_edges(heldout, hov) | canny_edges(methods['tile'], common)
        for s, v in sources: real |= canny_edges(s, v & common)
        self.items.append({'methods': methods, 'ho': heldout, 'hov': hov, 'sources': sources, 'geo': geo, 'common': common,
                           'real_dt': cv2.distanceTransform((~real).astype(np.uint8), cv2.DIST_L2, 5),
                           'ho_dt': cv2.distanceTransform((~canny_edges(heldout, hov)).astype(np.uint8), cv2.DIST_L2, 5)})

    def result(self):
        if not self.items: return None
        px = []
        for it in self.items:
            for im, v in it['sources']:
                lab = srgb_to_lab(cv2.GaussianBlur(im, (0, 0), 2))[v & it['common']]
                if lab.size: px.append(lab[::7])
        if not px: return None
        px = np.concatenate(px).astype(np.float32)
        if len(px) < 8: return None
        _, lbl, cent = cv2.kmeans(px, 4, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.1), 3, cv2.KMEANS_PP_CENTERS)
        names = list(self.items[0]['methods'].keys()); out = {}
        for name in names:
            geo_d, ho_d, inv_n, inv_t, nccs, laps, des, npx = [], [], 0, 0, [], [], [], 0
            for it in self.items:
                im = it['methods'][name]; valid = it['common']; ho = it['ho']; hov = it['hov']
                real_dt = it['real_dt']; ho_dt = it['ho_dt']
                e = canny_edges(im, valid)
                dt = cv2.distanceTransform((~e).astype(np.uint8), cv2.DIST_L2, 5)
                gy, gx = np.nonzero(it['geo'] & valid)
                if gy.size: geo_d.append(np.minimum(dt[gy, gx], 40))
                ov = valid & hov
                if ov.sum() > 400:
                    c = ncc(grad(gray(im), 2.0), grad(gray(ho), 2.0), ov)
                    if c is not None: nccs.append((c, int(ov.sum())))
                ey, ex = np.nonzero(e & ov)
                if ey.size: ho_d.append(np.minimum(ho_dt[ey, ex], 40))
                ey, ex = np.nonzero(e)
                inv_n += int((real_dt[ey, ex] > 4).sum()); inv_t += int(ey.size)
                lap = cv2.Laplacian(gray(im).astype(np.float64), cv2.CV_64F); laps.append((float(lap[valid].var()), int(valid.sum())))
                lab = srgb_to_lab(cv2.GaussianBlur(im, (0, 0), 2))[valid][::5]
                if lab.size: des.append(np.min(np.stack([de2000(lab, np.broadcast_to(c_, lab.shape)) for c_ in cent]), 0))
                npx += int(valid.sum())
            cat = lambda a: np.concatenate(a) if a else None
            g = cat(geo_d); hd = cat(ho_d); de = cat(des)
            wm = lambda a: round(sum(x * n for x, n in a) / max(1, sum(n for _, n in a)), 3) if a else None
            out[name] = {
                'pixels': npx,
                'geoChamferMedianPx': None if g is None or g.size < 50 else round(float(np.median(g)), 2),
                'geoChamferMeanPx': None if g is None or g.size < 50 else round(float(np.mean(g)), 2),
                'heldOutGradNcc': wm(nccs),
                'heldOutChamferMedianPx': None if hd is None else round(float(np.median(hd)), 2),
                'inventedEdgeShare': round(inv_n / inv_t, 3) if inv_t else None,
                'laplacianVar': None if not laps else round(sum(x * n for x, n in laps) / max(1, sum(n for _, n in laps)), 1),
                'dE00toPalette': None if de is None else round(float(de.mean()), 2)
            }
        return out


# ---------------------------------------------------------------- main
def main(d):
    t0 = time.time()
    job, views = load_job(d)
    global CACHE
    CACHE = DiskCache(job.get('cacheDir'))
    global ANCHOR_TO_OUTLINE
    ANCHOR_TO_OUTLINE = job.get('anchorToOutline', True)
    feat_cache = {}
    result = {'facades': [], 'charts': {}, 'heldOut': None}
    scorer = Scorer(); held = []
    for fac in job['facades']:
        placement, rep = place_facade(fac, views, d, feat_cache)
        result['facades'].append(rep)
        if placement is None: continue
        # held-out pano: placed by the reference chain (not the reference itself), largest footprint
        ho = None
        if job.get('heldOut', True):
            cands = [p for p in placement['panos'] if p != placement['ref'] and any(k in placement['K'] and placement['placed'][k][1]['placement'].startswith('feature') for k in placement['panos'][p])]
            if not cands:
                cands = [p for p in placement['panos'] if p != placement['ref'] and any(k in placement['K'] for k in placement['panos'][p])]
            if cands:
                ho = max(cands, key=lambda p: sum(views[k]['width'] * views[k]['height'] for k in placement['panos'][p] if k in placement['K']))
        rep['heldOutPano'] = ho
        if ho: held.append(ho)
        for chj in fac['charts']:
            tc = time.time()
            fr = load_frame(d, chj['frame'])
            region = np.fromfile(os.path.join(d, chj['region']), np.uint8).reshape(fr['H'], fr['W']) > 0
            # the photos are rectified on the tile's own surface, not on the fitted face: where the fit stands off the scan
            # (tens of cm on this kind of fit) a photo warped onto the fitted plane lands in the wrong place, differently in
            # every view. The plane moves along its normal to the median depth of the tile surface over the chart.
            d0 = fr['dev'][region & (np.abs(np.nan_to_num(fr['dev'], nan=99)) < 1.0)]
            offset = float(np.median(d0)) if d0.size > 50 else 0.0
            if offset:
                n_ = np.asarray(fr['plane']['normal'], np.float64)
                fr = load_frame(d, {**chj['frame'], 'plane': {'point': (np.asarray(fr['plane']['point']) + offset * n_).tolist(), 'normal': fr['plane']['normal']}})
            dev = fr['dev']
            devm = cv2.medianBlur(np.nan_to_num(dev, nan=99.0).astype(np.float32), 5)
            nonplanar = (np.abs(devm) > RELIEF_TOL_M)
            nonplanar = cv2.dilate(nonplanar.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            planar = region & ~nonplanar
            ch = {'fr': fr, 'region': planar}
            np_px = region & nonplanar
            finite = np.abs(dev[np_px & np.isfinite(dev)])
            crep = {'facade': fac['id'], 'regionPx': int(region.sum()), 'planeOffsetM': round(offset, 4), 'nonPlanarPx': int(np_px.sum()),
                    'nonPlanarNoSurfacePx': int((np_px & ~np.isfinite(dev)).sum()),
                    'nonPlanarP90M': None if not finite.size else round(float(np.percentile(finite, 90)), 3),
                    'nonPlanarMaxM': None if not finite.size else round(float(min(finite.max(), 99)), 3)}
            info = {}
            keys = list(placement['K'].keys())
            warped = warp_views(ch, views, placement, keys)
            fused, nag, use = fuse(ch, {k: list(v) for k, v in warped.items()}, views, placement['ref'], info)
            if fused is None:
                crep['views'] = 0; result['charts'][chj['id']] = crep; continue
            f1 = down2(fused); n1 = cv2.resize(nag, (f1.shape[1], f1.shape[0]), interpolation=cv2.INTER_NEAREST)
            cov1 = down2((nag > 0).astype(np.uint8) * 255) > 250
            mask = np.where(cov1, np.where(n1 >= 2, 2, 1), 0).astype(np.uint8)
            f1[mask == 0] = 0
            cv2.cvtColor(f1, cv2.COLOR_BGR2RGB).tofile(os.path.join(d, f"{chj['id']}_fused.rgb")); mask.tofile(os.path.join(d, f"{chj['id']}_mask.u8"))
            crep.update({'views': len(use), 'viewKeys': use, 'panoIds': sorted({views[k]['panoId'] for k in use}),
                         'dates': sorted({views[k].get('date') or '' for k in use} - {''}),
                         'coveredPx': int((mask > 0).sum()), 'multiViewPx': int((mask == 2).sum()), 'outW': int(f1.shape[1]), 'outH': int(f1.shape[0]),
                         'viewInfo': {k: v for k, v in info.items() if k in warped}})
            if job.get('debug'): crep['viewH'] = {k: v[2].tolist() for k, v in warped.items()}
            # held-out score
            if ho and chj.get('previous') and chj.get('tile'):
                hk = [k for k in placement['panos'][ho] if k in warped]
                if hk:
                    hk = max(hk, key=lambda k: int(warped[k][1].sum()))
                    loo = {k: list(v) for k, v in warped.items() if views[k]['panoId'] != ho}
                    fl, nl, ul = fuse(ch, loo, views, placement['ref'], {})
                    if fl is not None:
                        W1, H1 = f1.shape[1], f1.shape[0]
                        rd = lambda name: cv2.cvtColor(np.fromfile(os.path.join(d, chj[name]), np.uint8).reshape(H1, W1, 4), cv2.COLOR_RGBA2BGR)
                        rv = lambda name: np.fromfile(os.path.join(d, chj[name]), np.uint8).reshape(H1, W1, 4)[..., 3] > 0
                        prev, prevV = rd('previous'), rv('previous'); tile, tileV = rd('tile'), rv('tile')
                        loo1 = down2(fl); loov = down2((nl > 0).astype(np.uint8) * 255) > 250
                        hw = down2(warped[hk][0]); hv = down2(warped[hk][1].astype(np.uint8) * 255) > 250
                        common = loov & prevV & tileV & hv & (down2(planar.astype(np.uint8) * 255) > 250)
                        depth1 = fr['depthArr'][::2, ::2][:H1, :W1]
                        cam1 = {**fr['cam'], 'fx': fr['cam']['fx'] / 2, 'fy': fr['cam']['fy'] / 2, 'cx': fr['cam']['cx'] / 2, 'cy': fr['cam']['cy'] / 2}
                        geo = geometry_edges(cam1, depth1, down2(region.astype(np.uint8) * 255) > 250)
                        srcs = [(down2(warped[k][0]), down2(warped[k][1].astype(np.uint8) * 255) > 250) for k in ul]
                        scorer.add({'tile': tile, 'previous': prev, 'photoA': np.where(common[..., None], loo1, 0).astype(np.uint8)}, hw, hv, srcs, geo, common)
                        if job.get('debug'):
                            cv2.imwrite(os.path.join(d, f"{chj['id']}_score.png"), np.vstack([tile, prev, np.where(common[..., None], loo1, 0).astype(np.uint8), hw, np.dstack([common.astype(np.uint8) * 255] * 3)]))
                        crep['heldOutPx'] = int(common.sum())
            crep['seconds'] = round(time.time() - tc, 2)
            result['charts'][chj['id']] = crep
    sc = scorer.result()
    if sc: result['heldOut'] = {'panoIds': sorted(set(held)), 'methods': sc}
    result['seconds'] = round(time.time() - t0, 2)
    json.dump(result, open(os.path.join(d, 'result.json'), 'w'))


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except Exception as e:  # the caller records the failure as a degradation; the ladder continues below
        import traceback; traceback.print_exc()
        sys.exit(3)
