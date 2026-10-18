"""Photo tier A of the staged-location texture pass: real Street View pixels rectified onto fitted planar faces.

Called by packages/core/src/node/3d-engine/staged-location/photo-tier-rectify.ts with one argument, a job directory holding
job.json and the raw buffers it names. Writes result.json and, per chart, `<chart>_fused.rgb` / `<chart>_mask.u8` at the
chart's output (1x) resolution (mask 2: at least two panos agree; 1: one pano, past the occluder check; 0: nothing written).
Nothing here invents a pixel: every output pixel is a real photo pixel moved by a homography.

  1. every view is placed by its registered pose (the joint registration holds each wide view's face outline against the
     tile with its other terms, so there is one pose set for the projection and this tier); per chart (a fitted plane moved
     to the tile's surface under it) the plane homography of the pose warps the photo into a frontal virtual camera;
  2. per chart: spatially gated SIFT co-registration of each warp to the reference warp, a cross-view gradient agreement
     check, Lab normalisation to the reference, a per-pixel median over each pano's views, then over the panos (an occluder
     seen by some panos is outvoted);
  3. where only one pano covers a pixel nothing can outvote an occluder, so the pixel must also look like the face: not sky
     or vegetation by colour, and in agreement with the tile's low-frequency colour (after the chart's exposure offset).
Texels where the tile surface leaves the fitted plane by more than the relief tolerance are not rectified (the geometry
is wrong there; a photo warped onto it would smear): their measured deviation is reported.
The warps, their features and the co-registrations are cached per (photo, chart frame, homography) for the re-runs of
the same layer; charts run in parallel threads.

The held-out score (the offline experiment's score.py): one pano per facade is left out of a second fusion; tile render,
the previous ladder and photo tier A are scored against it on the same pixels.
"""
import hashlib, json, os, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import cv2

RELIEF_TOL_M = 0.30          # tile surface farther than this from the fitted plane: non-planar, not rectified
COREG_MIN_INLIERS = 30
AGREE_NCC = 0.25             # gradient NCC of a view against the reference warp to be fused
DEV_LAB = 20.0               # per-pixel Lab deviation from the median beyond which a view's pixel is an outlier
MIN_OVERLAP_PX = 2000
# the occluder check of single-pano pixels (CIE L*a*b*, L 0..100)
TILE_LOWPASS_M = 0.4         # the tile is soft: compare at this scale (Gaussian sigma)
TILE_DELTA_E = 15.0          # low-frequency CIE76 difference to the tile (after the chart's offset) past which a pixel is not the face
SKY_B = -8.0                 # b* below this with chroma above SKY_CHROMA: sky blue
SKY_CHROMA = 8.0
VEG_A = -6.0                 # a* below this: foliage green
REJECT_MARGIN_M = 0.15       # a rejected occluder's soft edge goes with it
CHART_THREADS = max(1, min(4, (os.cpu_count() or 2)))


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


_tls = threading.local()
def sift():
    if not hasattr(_tls, 'sift'): _tls.sift = cv2.SIFT_create(8000)
    return _tls.sift


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


# ---------------------------------------------------------------- loading
def load_job(d):
    job = json.load(open(os.path.join(d, 'job.json')))
    views = {}
    for v in job['views']:
        raw = np.fromfile(os.path.join(d, v['file']), np.uint8).reshape(v['height'], v['width'], 4)
        views[v['key']] = {**v, 'img': cv2.cvtColor(raw, cv2.COLOR_RGBA2BGR), 'sha': hashlib.sha1(raw.tobytes()).hexdigest()}
    return job, views


class DiskCache:
    """Cache of what one view contributes to one chart: its warp into the chart's frontal frame (keyed by the photo, the chart
    frame and the homography, so a pose change is a new entry), the warp's SIFT features and the co-registration of one warp to
    another. The leave-one-pano-out re-runs of a layer reuse them. Off when the job names no directory."""
    def __init__(self, d):
        self.d = d
        if d: os.makedirs(d, exist_ok=True)

    def warp(self, key, compute):
        if not self.d: return compute()
        p = os.path.join(self.d, f'warp_{key}.npz')
        if os.path.exists(p):
            try:
                z = np.load(p); return (z['w'], z['v'].astype(bool)) if z['ok'] else None
            except Exception:
                pass
        r = compute()
        tmp = p + f'.{os.getpid()}.{threading.get_ident()}.tmp.npz'
        if r is None: np.savez(tmp, ok=False, w=np.zeros(1, np.uint8), v=np.zeros(1, np.uint8))
        else: np.savez(tmp, ok=True, w=r[0], v=r[1].astype(np.uint8))
        os.replace(tmp, p)
        return r

    def json(self, key, compute):
        if not self.d: return compute()
        p = os.path.join(self.d, f'j_{key}.json')
        if os.path.exists(p):
            try: return json.load(open(p))
            except Exception: pass
        r = compute()
        tmp = p + f'.{os.getpid()}.{threading.get_ident()}.tmp'
        json.dump(r, open(tmp, 'w')); os.replace(tmp, p)
        return r


CACHE = DiskCache(None)


def load_frame(d, fr):
    depth = np.fromfile(os.path.join(d, fr['depth']), np.float32).reshape(fr['H'], fr['W'])
    dev, zplane = plane_depth_and_dev(fr['cam'], fr['W'], fr['H'], fr['plane'], depth)
    return {**fr, 'depthArr': depth, 'dev': dev}


# ---------------------------------------------------------------- placement of the views on one facade
def place_facade(fac, views):
    """Every view at its registered pose: the joint registration (pano-joint-registration.ts) already holds each wide view's
    face outline against the tile, with the cross-view consistency and the edges, so the projection and this tier read the
    photos through one pose set. The reference pano (for co-registration and the Lab normalisation) is the one with most views."""
    t0 = time.time()
    keys = [k for k in fac['views'] if k in views]
    rep = {'id': fac['id'], 'panos': {}, 'views': {}}
    panos = {}
    for k in keys: panos.setdefault(views[k]['panoId'], []).append(k)
    if not panos:
        rep['skipped'] = 'no registered view looks at this facade'
        return None, rep
    ref = max(sorted(panos), key=lambda p: len(panos[p]))
    rep['reference'] = ref
    for pid, ks in panos.items(): rep['panos'][pid] = {'views': len(ks)}
    for k in keys: rep['views'][k] = {'placement': 'registered pose'}
    rep['seconds'] = round(time.time() - t0, 2)
    return {'K': {k: np.eye(3) for k in keys}, 'ref': ref, 'placed': {k: (None, rep['views'][k]) for k in keys}, 'panos': panos}, rep


# ---------------------------------------------------------------- fusion on one chart
def frame_key(fr):
    """Identity of a chart frame (camera, size, plane): part of the warp cache key."""
    c = fr['cam']
    vals = list(c['eye']) + list(c['right']) + list(c['up']) + list(c['fwd']) + [c['fx'], c['fy'], c['cx'], c['cy'], fr['W'], fr['H']] + list(fr['plane']['point']) + list(fr['plane']['normal'])
    return hashlib.sha1(np.round(np.asarray(vals, np.float64), 6).tobytes()).hexdigest()[:16]


def warp_views(ch, views, placement, keys):
    fr = ch['fr']; W, H = fr['W'], fr['H']; out = {}
    M = ch['region']; fk = frame_key(fr)
    for k in keys:
        if k not in placement['K']: continue
        H0 = plane_homography(views[k]['cam'], fr['cam'], W, H, fr['plane'])
        if H0 is None: continue
        Hc = H0 @ placement['K'][k]
        img = views[k]['img']
        wkey = hashlib.sha1((views[k]['sha'] + fk).encode() + np.round(Hc / Hc[2, 2], 6).tobytes()).hexdigest()

        def compute():
            w = cv2.warpPerspective(img, Hc, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            v = cv2.warpPerspective(np.full(img.shape[:2], 255, np.uint8), Hc, (W, H), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT) > 0
            return w, cv2.erode(v.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        r = CACHE.warp(wkey, compute)
        if r is None: continue
        w, v = r
        v = v & M
        if v.sum() < max(200, 0.02 * M.sum()): continue
        out[k] = [w, v, Hc, wkey]
    return out


def fuse(ch, warped, views, ref_pano, info):
    """Per-pixel median fusion with a cross-view agreement check. Returns (fused BGR, agreeing panos per pixel, used keys)."""
    M = ch['region']
    if not warped: return None, None, []
    order = sorted(warped, key=lambda k: (views[k]['panoId'] != ref_pano, -int(warped[k][1].sum()), k))
    ref = order[0]
    W_, H_ = ch['fr']['W'], ch['fr']['H']
    # spatially gated co-registration to the reference warp (chart frame); cached per pair of warps
    if min(W_, H_) >= 120 and len(order) > 1:
        fr_ = None
        for k in order[1:]:
            def compute():
                nonlocal fr_
                if fr_ is None: fr_ = feats(warped[ref][0], (warped[ref][1]).astype(np.uint8) * 255)
                fk = feats(warped[k][0], warped[k][1].astype(np.uint8) * 255)
                Hm, n, res = match_h(fk, fr_, 3.0, gate=40)
                return {'H': None if Hm is None else Hm.tolist(), 'n': int(n)}
            c = CACHE.json(hashlib.sha1(('coreg' + warped[k][3] + warped[ref][3]).encode()).hexdigest(), compute)
            rec = info.setdefault(k, {}); rec.setdefault('coreg', []).append(c['n'])
            if c['H'] is not None and c['n'] >= COREG_MIN_INLIERS:
                Hm = np.asarray(c['H'], np.float64)
                w, v = warped[k][0], warped[k][1]
                warped[k] = [cv2.warpPerspective(w, Hm, (W_, H_), flags=cv2.INTER_LINEAR), (cv2.warpPerspective(v.astype(np.uint8), Hm, (W_, H_), flags=cv2.INTER_NEAREST) > 0) & M, warped[k][2], warped[k][3]]
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
    # the median votes per PANO: a pano's views share its eye, so a van in front of it is in all of them; within a pano, the
    # per-pixel median of its views (a passer-by that moved between two crops of the capture is dropped there)
    pids = [views[k]['panoId'] for k in use]
    with np.errstate(all='ignore'):
        per = np.stack([np.nanmedian(np.where(Vs[[i for i, p in enumerate(pids) if p == q]][..., None], Ls[[i for i, p in enumerate(pids) if p == q]], np.nan), axis=0) for q in dict.fromkeys(pids)])
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


def cie_lab(bgr):
    """CIE L*a*b* (L 0..100) of an 8-bit BGR image."""
    return cv2.cvtColor(bgr.astype(np.float32) / 255.0, cv2.COLOR_BGR2LAB)


def occluder_check(f1, mask, tile, tile_v, mpp):
    """Single-pano pixels (mask 1) that do not look like the face: sky or vegetation by colour, or off the tile's low-frequency
    colour by more than TILE_DELTA_E after the chart's exposure offset (median over the pixels both cover, the multi-pano ones
    first). Returns the rejection mask (with its margin, on single-pano pixels only) and counts."""
    single = mask == 1
    out = {'singlePx': int(single.sum()), 'sky': 0, 'vegetation': 0, 'tile': 0, 'rejectedPx': 0}
    if not single.any(): return np.zeros_like(single), out
    L = cie_lab(f1)
    chroma = np.hypot(L[..., 1], L[..., 2])
    sky = single & (L[..., 2] < SKY_B) & (chroma > SKY_CHROMA)
    veg = single & (L[..., 1] < VEG_A)
    rej = sky | veg
    out['sky'] = int(sky.sum()); out['vegetation'] = int(veg.sum())
    if tile is not None and tile_v is not None and tile_v.any():
        sig = max(1.0, TILE_LOWPASS_M / mpp)
        cov = (mask > 0) & tile_v
        def lowpass(img_lab, m):
            w = cv2.GaussianBlur(m.astype(np.float32), (0, 0), sig)
            return np.stack([cv2.GaussianBlur(np.where(m, img_lab[..., c], 0).astype(np.float32), (0, 0), sig) for c in range(3)], -1) / np.maximum(w, 1e-6)[..., None], w
        Lf, wf = lowpass(L, cov)
        Lt, wt = lowpass(cie_lab(tile), cov)
        ref = cov & (mask == 2)
        if ref.sum() < 200: ref = cov
        off = np.median((Lf - Lt)[ref], axis=0) if ref.any() else np.zeros(3)
        dE = np.linalg.norm(Lf - Lt - off, axis=2)
        tl = single & tile_v & (wf > 0.3) & (dE > TILE_DELTA_E)
        out['tile'] = int((tl & ~rej).sum()); out['tileOffsetLab'] = [round(float(x), 2) for x in off]
        rej |= tl
    r = max(1, int(round(REJECT_MARGIN_M / mpp)))
    rej = (cv2.dilate(rej.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0) & single
    out['rejectedPx'] = int(rej.sum())
    return rej, out


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
def do_chart(d, job, fac, chj, placement, ho, views, scorer, lock):
    tc = time.time()
    fr = load_frame(d, chj['frame'])
    region = np.fromfile(os.path.join(d, chj['region']), np.uint8).reshape(fr['H'], fr['W']) > 0
    # the photos are rectified on the tile's own surface, not on the fitted face: where the fit stands off the scan (tens of
    # cm on this kind of fit) a photo warped onto the fitted plane lands in the wrong place, differently in every view. The
    # plane moves along its normal to the median depth of the tile surface over the chart.
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
        crep['views'] = 0; crep['seconds'] = round(time.time() - tc, 2); return chj['id'], crep
    f1 = down2(fused); n1 = cv2.resize(nag, (f1.shape[1], f1.shape[0]), interpolation=cv2.INTER_NEAREST)
    cov1 = down2((nag > 0).astype(np.uint8) * 255) > 250
    mask = np.where(cov1, np.where(n1 >= 2, 2, 1), 0).astype(np.uint8)
    W1, H1 = f1.shape[1], f1.shape[0]
    rd = lambda name: cv2.cvtColor(np.fromfile(os.path.join(d, chj[name]), np.uint8).reshape(H1, W1, 4), cv2.COLOR_RGBA2BGR)
    rv = lambda name: np.fromfile(os.path.join(d, chj[name]), np.uint8).reshape(H1, W1, 4)[..., 3] > 0
    tile, tileV = (rd('tile'), rv('tile')) if chj.get('tile') else (None, None)
    rej, occ = occluder_check(f1, mask, tile, tileV, 2 * chj['frame']['mpp'])   # metres per output (1x) pixel
    mask[rej] = 0
    f1[mask == 0] = 0
    cv2.cvtColor(f1, cv2.COLOR_BGR2RGB).tofile(os.path.join(d, f"{chj['id']}_fused.rgb")); mask.tofile(os.path.join(d, f"{chj['id']}_mask.u8"))
    crep.update({'views': len(use), 'viewKeys': use, 'panoIds': sorted({views[k]['panoId'] for k in use}),
                 'dates': sorted({views[k].get('date') or '' for k in use} - {''}),
                 'coveredPx': int((mask > 0).sum()), 'multiViewPx': int((mask == 2).sum()), 'outW': int(W1), 'outH': int(H1), 'occluder': occ,
                 'viewInfo': {k: v for k, v in info.items() if k in warped}})
    if job.get('debug'): crep['viewH'] = {k: v[2].tolist() for k, v in warped.items()}
    # held-out score
    if ho and chj.get('previous') and tile is not None:
        hk = [k for k in placement['panos'][ho] if k in warped]
        if hk:
            hk = max(hk, key=lambda k: int(warped[k][1].sum()))
            loo = {k: list(v) for k, v in warped.items() if views[k]['panoId'] != ho}
            fl, nl, ul = fuse(ch, loo, views, placement['ref'], {})
            if fl is not None:
                prev, prevV = rd('previous'), rv('previous')
                loo1 = down2(fl); loov = down2((nl > 0).astype(np.uint8) * 255) > 250
                hw = down2(warped[hk][0]); hv = down2(warped[hk][1].astype(np.uint8) * 255) > 250
                common = loov & prevV & tileV & hv & (down2(planar.astype(np.uint8) * 255) > 250)
                depth1 = fr['depthArr'][::2, ::2][:H1, :W1]
                cam1 = {**fr['cam'], 'fx': fr['cam']['fx'] / 2, 'fy': fr['cam']['fy'] / 2, 'cx': fr['cam']['cx'] / 2, 'cy': fr['cam']['cy'] / 2}
                geo = geometry_edges(cam1, depth1, down2(region.astype(np.uint8) * 255) > 250)
                srcs = [(down2(warped[k][0]), down2(warped[k][1].astype(np.uint8) * 255) > 250) for k in ul]
                with lock:
                    scorer.add({'tile': tile, 'previous': prev, 'photoA': np.where(common[..., None], loo1, 0).astype(np.uint8)}, hw, hv, srcs, geo, common)
                if job.get('debug'):
                    cv2.imwrite(os.path.join(d, f"{chj['id']}_score.png"), np.vstack([tile, prev, np.where(common[..., None], loo1, 0).astype(np.uint8), hw, np.dstack([common.astype(np.uint8) * 255] * 3)]))
                crep['heldOutPx'] = int(common.sum())
    crep['seconds'] = round(time.time() - tc, 2)
    return chj['id'], crep


def main(d):
    t0 = time.time()
    job, views = load_job(d)
    global CACHE
    CACHE = DiskCache(job.get('cacheDir'))
    result = {'facades': [], 'charts': {}, 'heldOut': None}
    scorer = Scorer(); held = []; lock = threading.Lock()
    tasks = []
    for fac in job['facades']:
        placement, rep = place_facade(fac, views)
        result['facades'].append(rep)
        if placement is None: continue
        # held-out pano: not the reference, the largest footprint
        ho = None
        if job.get('heldOut', True):
            cands = [p for p in sorted(placement['panos']) if p != placement['ref']]
            if cands:
                ho = max(cands, key=lambda p: sum(views[k]['width'] * views[k]['height'] for k in placement['panos'][p]))
        rep['heldOutPano'] = ho
        if ho: held.append(ho)
        for chj in fac['charts']: tasks.append((fac, chj, placement, ho))
    with ThreadPoolExecutor(max_workers=CHART_THREADS) as ex:
        for cid, crep in ex.map(lambda t: do_chart(d, job, t[0], t[1], t[2], t[3], views, scorer, lock), tasks):
            result['charts'][cid] = crep
    sc = scorer.result()
    if sc: result['heldOut'] = {'panoIds': sorted(set(held)), 'methods': sc}
    result['seconds'] = round(time.time() - t0, 2)
    result['threads'] = CHART_THREADS
    json.dump(result, open(os.path.join(d, 'result.json'), 'w'))


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except Exception as e:  # the caller records the failure as a degradation; the ladder continues below
        import traceback; traceback.print_exc()
        sys.exit(3)
