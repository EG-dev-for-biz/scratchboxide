#!/usr/bin/env python3
"""
Builds public/plaza_matchmove_eloise.html from the Plaza matchmove demo page with the Eloise shot: the tile
blockout rendered along the solved camera path (Step 1), the Omni video (Step 3), the solved path and a cropped
tile commit in the 3D view, and measured values in the telemetry and check panels. Every replacement must match
the template exactly the expected number of times, so template drift fails the build instead of shipping stale
content.
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

import tile_render as tr

REPO = Path(__file__).resolve().parents[2]
MILESTONE_FRAMES = [(1, 'Roofline'), (49, 'Turret'), (96, 'Upper facade'), (120, 'Canopy'), (150, 'Entrance'), (190, 'Street'), (240, 'Nadir')]


class Template:
    def __init__(self, text):
        self.text = text

    def sub(self, old, new, count=1):
        found = self.text.count(old)
        if found != count:
            raise SystemExit(f'template: expected {count} x {old[:70]!r}, found {found}')
        self.text = self.text.replace(old, new)

    def block(self, start, new, open_ch='[', close_ch=']'):
        """Replaces from `start` through the bracket that closes the first `open_ch` after it."""
        i = self.text.find(start)
        if i < 0 or self.text.find(start, i + 1) >= 0:
            raise SystemExit(f'template: expected one {start[:60]!r}')
        j = self.text.index(open_ch, i)
        depth, quote, k = 0, None, j
        while k < len(self.text):
            ch = self.text[k]
            if quote:
                if ch == '\\':
                    k += 1
                elif ch == quote:
                    quote = None
            elif ch in '\'"`':
                quote = ch
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    self.text = self.text[:i] + new + self.text[k + 1:]
                    return
            k += 1
        raise SystemExit(f'template: unbalanced block after {start[:60]!r}')

    def between(self, start, end, new):
        i = self.text.find(start)
        j = self.text.find(end, i + len(start))
        if i < 0 or j < 0 or self.text.find(start, i + 1) >= 0:
            raise SystemExit(f'template: expected one {start[:60]!r} ... {end[:40]!r}')
        self.text = self.text[:i] + new + self.text[j:]


def frame_png(video, index, out):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(video), '-vf', f'select=eq(n\\,{index - 1}),scale=640:-2', '-frames:v', '1', '-q:v', '3', str(out)], check=True)


def nearest(rows, frame, key):
    measured = [r for r in rows if r.get(key) is not None]
    if not measured:
        return None
    return min(measured, key=lambda r: abs(r['frame'] - frame))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shot', default=str(REPO / '.scratchbox/matchmove/eloise_plaza'))
    ap.add_argument('--template', default=str(REPO / 'public/plaza_matchmove_demo.html'))
    ap.add_argument('--out', default=str(REPO / 'public/plaza_matchmove_eloise.html'))
    ap.add_argument('--crop-glb', default='world/plaza-hotel/eloise-crop/plaza-hotel-eloise-crop.glb')
    args = ap.parse_args()
    shot, public = Path(args.shot), REPO / 'public'

    path = json.loads((shot / 'final/camera_path.json').read_text())
    tile_metrics = json.loads((shot / 'measure_v2/alignment_metrics.json').read_text())
    adherence = json.loads((shot / 'omni/adherence.json').read_text())
    verify = json.loads((shot / 'omni/verify.json').read_text())
    interaction = json.loads((shot / 'omni/interaction.json').read_text())
    crop_commit = json.loads((public / Path(args.crop_glb).parent / 'commit.json').read_text())
    frames = path['frames']
    n = len(frames)
    fps = path['plate']['fps']
    duration = n / fps
    scrub = (n - 1) / fps  # time of the last frame; the page maps t -> frame index as t / scrub * (n - 1)
    scrub = (n - 1) / fps  # time of the last frame; the page maps t -> frame index as t / scrub * (n - 1)
    vfov = path['plate']['verticalFovDeg']
    k1 = path['plate']['lens']['k1']

    # Distance to the tile surface along the view axis, from the cropped commit (sampled, then interpolated).
    sampled, dist = [], []
    for i in list(range(0, n, 8)) + [n - 1]:
        c, R = np.array(frames[i]['center']), np.array(frames[i]['R'])
        r = tr.render(public / args.crop_glb, c, c + R[2] * 20.0, -R[1], vfov, 32, 18, spp=1)
        d = r['depth'][9, 16]
        if d > 0:
            sampled.append(i)
            dist.append(float(d))
    standoff = list(np.interp(np.arange(n), sampled, dist)) if sampled else [float('nan')] * n
    rows = []
    for f, s in zip(frames, standoff):
        c, t, R = np.array(f['center']), np.array(f['target']), np.array(f['R'])
        pitch = float(np.degrees(np.arcsin(np.clip(R[2][1], -1, 1))))
        rows.append([round(v, 3) for v in (*c, *t)] + [round(pitch, 2), round(vfov, 2), round(s, 2) if np.isfinite(s) else 0.0, round(k1, 4)])
    ups = [[round(v, 4) for v in f['up']] for f in frames]

    videos, images = public / 'videos', public / 'images'
    videos.mkdir(exist_ok=True)
    images.mkdir(exist_ok=True)
    shutil.copyfile(shot / 'omni/blockout.mp4', videos / 'eloise_blockout.mp4')
    shutil.copyfile(shot / 'omni/omni_recreation.mp4', videos / 'eloise_omni.mp4')

    milestones = []
    for i, (fr, label) in enumerate(MILESTONE_FRAMES):
        f = frames[fr - 1]
        frame_png(shot / 'omni/blockout.mp4', fr, images / f'eloise_blockout_f{fr}.jpg')
        frame_png(shot / 'omni/omni_recreation.mp4', fr, images / f'eloise_omni_f{fr}.jpg')
        tile = nearest(tile_metrics['frames'], fr, 'medianOffsetPx')
        tile_text = f"{tile['medianOffsetPx']:.0f} px (F{tile['frame']})" if tile and abs(tile['frame'] - fr) <= 6 else 'not measurable'
        om = next((r for r in adherence['frames'] if abs(r['frame'] - fr) <= 6), None)
        om_text = f"{om['medianOffsetPx']:.0f} px (F{om['frame']})" if om and om['medianOffsetPx'] is not None else 'no match'
        row = rows[fr - 1]
        anchor = f.get('anchor') or 'interpolated'
        milestones.append({
            'index': i, 'kfNumber': i + 1, 'phase': f'F{fr}', 'frame': fr, 'time': (fr - 1) / fps,
            'pos': row[0:3], 'target': row[3:6], 'pitch': row[6], 'fov': row[7], 'alt': row[1], 'standoff': row[8],
            'curvature': '—', 'omega': '—', 'overlap': tile_text, 'residual': om_text, 'tolerance': '—',
            'shortLabel': label, 'name': label,
            'desc': (f'Frame {fr} ({(fr - 1) / fps:.2f} s). Camera pose source: {anchor}. '
                     f'Tile blockout vs source: {tile_text}. Omni vs source: {om_text}.'),
            'imgBlockout': f'images/eloise_blockout_f{fr}.jpg', 'imgComparison': f'images/eloise_omni_f{fr}.jpg'
        })

    s = tile_metrics['summary']
    measured_omni = [r for r in adherence['frames'] if r['medianOffsetPx'] is not None]
    first = next(r for r in adherence['frames'] if r['frame'] == 1)
    last = adherence['frames'][-1]
    mid = [r for r in adherence['frames'] if 40 <= r['frame'] <= 190]
    mid_bad = [r for r in mid if r['medianOffsetPx'] is None or r['medianOffsetPx'] > 100]
    colmap = json.loads((shot / 'colmap/track.json').read_text())
    registered = sum(1 for fr in colmap['frames'] if fr['registered'])
    checks = [
        ('Camera track from the source clip (COLMAP)', f"{registered}/{len(colmap['frames'])} FRAMES", True),
        ('Tile alignment, anchor frames (median)', f"{s['anchorFrames']['medianOffsetPx']:.1f} PX", None),
        (f"Tile alignment, held-out frames (gate {s['gate']['medianPx']:.0f} px)", f"FAILED · {s['heldOut']['medianOffsetPx']:.1f} PX", False),
        ('Frames measurable against the tiles', f"{s['framesMeasured']}/{s['framesSampled']}", None),
        ('Omni: single continuous shot', 'PASSED · NO CUTS' if not adherence['sceneCutsAt'] else f"FAILED · {len(adherence['sceneCutsAt'])} CUTS", not adherence['sceneCutsAt']),
        ('Omni: pinned first / last frame vs source', f"{first['medianOffsetPx']:.0f} / {last['medianOffsetPx']:.0f} PX", True),
        ('Omni: follows the source between the pins', f"FAILED · {len(mid_bad)}/{len(mid)} MID FRAMES OFF", False if mid_bad else True),
        ('Omni: empty streets (people / vehicles detected)', f"{verify['detectionsTotal']} IN {len(verify['sampledFrames'])} FRAMES", verify['detectionsTotal'] == 0),
    ]

    t = Template((Path(args.template)).read_text())
    t.sub('<title>Scratchbox IDE — Plaza Hotel 6-DOF Video Path Recreation & Matchmove Test Demo</title>',
          '<title>Scratchbox IDE — The Plaza Hotel · Eloise Shot Recreation</title>')
    t.sub('<div class="brand-title">The Plaza Hotel 6-DOF Video Path Recreation & Matchmove Test</div>',
          '<div class="brand-title">The Plaza Hotel · Eloise Shot Recreation</div>')
    t.sub('<div class="brand-sub">Manhattan Central Park South | 4K Photogrammetric Solve | Hermite Spline & Slerp Trajectory</div>',
          f'<div class="brand-sub">Camera solved from the source clip | Omni 1.1 Flash from first + last frame + tile blockout | Tile commit {path["baseCommit"]} ({path["baseCommitSha256"][:8]})</div>')
    t.sub('videos/plaza_hotel_blockout_camera.mp4', 'videos/eloise_blockout.mp4', count=2)
    t.sub('videos/plaza_hotel_omni_15s_720p.mp4', 'videos/eloise_omni.mp4', count=2)
    t.sub("'models/google_tiles_textured_area.glb'", f"'{args.crop_glb}'")
    t.sub('Mesh: google_tiles_textured_area.glb (120,652 verts)',
          f"Mesh: {Path(args.crop_glb).name} ({crop_commit['source']['tileCount']} leaf tiles, parent {crop_commit['parent']})", count=2)
    t.sub('Spline: Catmull-Rom 361 Frames<br>', f'Solved path: {n} frames (SfM track bent through tile anchors)<br>')
    t.sub('Gimbal Free: Facade Up-Vector Interpolation<br>', 'Up vector: solved per frame<br>')
    t.sub('Descent: 82.0 m &rarr; 10.5 m (&minus;30&deg; &rarr; &minus;90&deg; Nadir)',
          f'Descent: {rows[0][1]:.1f} m &rarr; {rows[-1][1]:.1f} m above the street')
    t.sub('<span class="tag" id="statusBadge">ALIGNMENT NOT MEASURED</span>', '<span class="tag" id="statusBadge">MEASURED · TILE GATE FAILED</span>')
    t.sub('<div class="telem-label">Edge Correlation</div>', '<div class="telem-label">Tile vs Source</div>')
    t.sub('<div class="telem-label">RMS Residual</div>', '<div class="telem-label">Omni vs Source</div>')
    t.sub('<div class="telem-label">Solver Model</div>', '<div class="telem-label">Omni Model</div>')
    t.sub('<div class="telem-val highlight" id="teleSolver">HERMITE-SLERP</div>', '<div class="telem-val highlight" id="teleSolver">OMNI 1.1 FLASH</div>')
    t.sub('<div class="telem-val" id="teleMesh">4,277 VERTS</div>',
          f"<div class=\"telem-val\" id=\"teleMesh\">{crop_commit['glb']['triangleCount']:,} TRIS</div>")
    t.sub('<div class="telem-label">Standoff Dist</div>', '<div class="telem-label">Surface Dist</div>')
    t.between('<button class="jump-btn" onclick="jumpToAnchor(0)">F1: Mansard</button>',
              '<button class="jump-btn" style="color: #38bdf8;',
              ''.join(f'<button class="jump-btn" onclick="jumpToAnchor({i})">F{fr}: {label}</button>\n          '
                      for i, (fr, label) in enumerate(MILESTONE_FRAMES) if label in ('Roofline', 'Upper facade', 'Canopy', 'Street', 'Nadir')))
    t.sub('<span>Dense Keyframes (25 Anchors)</span>', f'<span>Keyframes ({len(milestones)} milestones)</span>')
    t.sub('<span class="tag green">5 FLIGHT PHASES</span>', '<span class="tag green">SOLVED PATH</span>')
    t.sub('<span>Automated Matchmove Test Suite</span>', '<span>Measured Checks</span>')
    t.between('<div class="test-item" id="testRow1">', '<div style="margin-top: 14px; background: rgba(16, 185, 129, 0.1);',
              ''.join(f'<div class="test-item" id="testRow{i}">\n            <div class="test-name">\n              <span class="test-dot" id="dot{i}"></span>\n'
                      f'              <span>{i}. {name}</span>\n            </div>\n            <span class="test-status" id="stat{i}">{status}</span>\n          </div>\n          '
                      for i, (name, status, _) in enumerate(checks, 1)) + '</div>\n\n        ')
    t.between('<b style="color: #34d399;">✓ MATCHMOVE TEST PASSED (100% PRECISION)</b>', '</div>',
              f'<b style="color: #fbbf24;">Partial recreation</b><br><span style="color: var(--text-muted); font-size: 10px;">'
              f'Omni matches the source at the pinned first and last frames and keeps the streets empty; between them it takes its own path. '
              f'Tile alignment: {s["framesMeasured"]}/{s["framesSampled"]} sampled frames measurable, held-out median {s["heldOut"]["medianOffsetPx"]:.1f} px, '
              f'worst {s["worstFrameMedianOffsetPx"]:.0f} px (frame {s["worstFrame"]}). Omni interaction {interaction["interactionId"][:12]}…</span>')

    t.sub('<div>FRAME: <span id="frameReadout" style="color: #f8fafc; font-weight: 700;">1 / 361</span> (24.00 FPS)</div>',
          f'<div>FRAME: <span id="frameReadout" style="color: #f8fafc; font-weight: 700;">1 / {n}</span> ({fps:.2f} FPS)</div>')
    t.sub('<div>DURATION: <span>15.04s</span></div>', f'<div>DURATION: <span>{duration:.2f}s</span></div>')
    t.sub('max="15.0" step="0.041666"', f'max="{scrub:.6f}" step="{1 / fps:.6f}"')
    t.sub('title="Jump to End (Frame 361)"', f'title="Jump to End (Frame {n})"')

    t.block('const GROUND_TRUTH_TRAJECTORY_361 = ',
            f'const SHOT_DURATION = {scrub:.6f};\n    const TOTAL_FRAMES = {n};\n    const PATH_UP = {json.dumps(ups)};\n'
            f'    const MEASURED_CHECKS = {json.dumps([{"status": st, "pass": ok} for _, st, ok in checks])};\n'
            f'    const GROUND_TRUTH_TRAJECTORY_361 = {json.dumps(rows)}')
    t.block('    function computeUpVector(t) ', '''    function computeUpVector(t) {
      const x = Math.max(0, Math.min(1, t / SHOT_DURATION)) * (PATH_UP.length - 1);
      const i0 = Math.floor(x), i1 = Math.min(PATH_UP.length - 1, i0 + 1), a = x - i0;
      return new THREE.Vector3(
        PATH_UP[i0][0] * (1 - a) + PATH_UP[i1][0] * a,
        PATH_UP[i0][1] * (1 - a) + PATH_UP[i1][1] * a,
        PATH_UP[i0][2] * (1 - a) + PATH_UP[i1][2] * a
      ).normalize();
    }''', open_ch='{', close_ch='}')
    t.block('const MILESTONES = ', 'const MILESTONES = ' + json.dumps(milestones, indent=2, ensure_ascii=False))
    t.block('    window.runMatchmoveTest = async function() ', '''    window.runMatchmoveTest = async function() {
      MEASURED_CHECKS.forEach((c, i) => {
        const dot = document.getElementById(`dot${i + 1}`);
        const stat = document.getElementById(`stat${i + 1}`);
        if (dot) dot.className = 'test-dot' + (c.pass === true ? ' passed' : '');
        if (stat) {
          stat.className = 'test-status' + (c.pass === true ? ' passed' : '');
          stat.style.color = c.pass === false ? '#f87171' : '';
          stat.textContent = c.status;
        }
      });
      const failed = MEASURED_CHECKS.filter(c => c.pass === false).length;
      suiteScoreTag.textContent = failed ? `${failed} FAILED` : 'ALL PASSED';
      suiteScoreTag.className = failed ? 'tag' : 'tag green';
      testSummaryAlert.style.display = 'block';
    }''', open_ch='{', close_ch='}')

    t.sub('Math.max(0.0, Math.min(15.0, t))', 'Math.max(0.0, Math.min(SHOT_DURATION, t))')
    t.sub('(clampedT / 15.0)', '(clampedT / SHOT_DURATION)')
    t.sub('frameNumber: Math.min(361, ', 'frameNumber: Math.min(TOTAL_FRAMES, ')
    t.sub('currentTime = Math.max(0, Math.min(15.0, time));', 'currentTime = Math.max(0, Math.min(SHOT_DURATION, time));')
    t.sub('const totalFrames = 361;', 'const totalFrames = TOTAL_FRAMES;')
    t.sub('Math.floor((currentTime / 15.0) * (totalFrames - 1))', 'Math.round((currentTime / SHOT_DURATION) * (totalFrames - 1))')
    t.sub('Math.min(15.0, currentTime + ', 'Math.min(SHOT_DURATION, currentTime + ', count=3)
    t.sub('updateSceneState(15.0, MILESTONES.length - 1)', 'updateSceneState(SHOT_DURATION, MILESTONES.length - 1)', count=2)
    t.sub('if (currentTime >= 15.0)', 'if (currentTime >= SHOT_DURATION)')
    t.sub("textContent = '361-FRAME EXACT';", "textContent = `${TOTAL_FRAMES}-FRAME SOLVED PATH`;")
    t.sub('teleStandoff.textContent = `${distToTarget.toFixed(2)} m`;', 'teleStandoff.textContent = `${traj.standoff.toFixed(2)} m`;')
    t.sub('if (standoffEl) standoffEl.textContent = `${distToTarget.toFixed(2)} m`;', 'if (standoffEl) standoffEl.textContent = `${traj.standoff.toFixed(2)} m`;')
    t.sub('<div>STANDOFF: <span id="standoffReadout"', '<div>SURFACE DIST: <span id="standoffReadout"')

    Path(args.out).write_text(t.text)
    print(f'wrote {args.out}: {n} frames, {len(milestones)} milestones, {len(checks)} checks')


if __name__ == '__main__':
    main()
