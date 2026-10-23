#!/usr/bin/env python3
"""
Report a staged location build (one run under .scratchbox/cache/staged_location/runs/<id>/) and score it against the
Haughwout baseline (references/haughwout_baseline.json next to this script): the stage timeline with each stage's
status and first reason, the massing check (pipeline_e.json), every pipeline G step with its accepted/proposed counts,
and a verdict line per baseline measure (met / below / n/a). Run with no argument for the newest run, `--wait` to
block until the run's finish stage is written, `--json` for machine output.

Usage:
  python3 staged_run_report.py [run-id-or-prefix] [--wait] [--json] [--runs DIR]
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, '..', 'references', 'haughwout_baseline.json')


def find_runs_dir(explicit):
    if explicit:
        return explicit
    d = os.getcwd()
    while True:
        cand = os.path.join(d, '.scratchbox', 'cache', 'staged_location', 'runs')
        if os.path.isdir(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit('no .scratchbox/cache/staged_location/runs above the working directory; pass --runs')
        d = parent


def pick_run(runs_dir, wanted):
    ids = sorted(os.listdir(runs_dir), key=lambda n: os.path.getmtime(os.path.join(runs_dir, n)), reverse=True)
    if not ids:
        sys.exit('no runs')
    if not wanted:
        return ids[0]
    hits = [i for i in ids if i.startswith(wanted)]
    if not hits:
        sys.exit(f'no run starts with {wanted}')
    return hits[0]


def read_timeline(run_dir):
    rows = []
    p = os.path.join(run_dir, 'timeline.jsonl')
    if not os.path.exists(p):
        return rows
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # a partially written last line
                continue
    return rows


def finished(run_dir):
    return any(r.get('stage') == 'finish' for r in read_timeline(run_dir))


def stage_table(rows):
    """Last record per stage, in first-seen order, with its reason when it has one."""
    order, last = [], {}
    for r in rows:
        s = r.get('stage')
        if s not in last:
            order.append(s)
        last[s] = r
    out = []
    for s in order:
        r = last[s]
        tri = sum(l.get('triangles', 0) for l in r.get('layers', []) or [])
        out.append({'stage': s, 'status': r.get('status'), 'ms': r.get('ms'), 'cached': r.get('cached'), 'triangles': tri or None, 'reason': r.get('reason')})
    return out


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def g_steps(pg):
    steps = []
    for s in (pg or {}).get('steps', []):
        steps.append({'step': s.get('step'), 'accepted': s.get('accepted'), 'proposed': s.get('proposed'), 'rejected': s.get('rejected'), 'ms': s.get('ms'), 'skipped': s.get('skipped'), 'notes': s.get('notes', [])})
    return steps


def native_build_detail(steps):
    """Openings rejected by the native tool, counted by reading group (a g10 of 280 is one bad reading, not 280 problems)."""
    for s in steps:
        if s['step'] == 'native build':
            rej = [n for n in s['notes'] if 'rejected by the native tool' in n]
            by = {}
            for n in rej:
                m = re.match(r'opening (g\d+)_', n)
                k = m.group(1) if m else '?'
                by[k] = by.get(k, 0) + 1
            return {'rejected': len(rej), 'byGroup': by, 'summary': next((n for n in s['notes'] if 'rejected by' not in n), '')}
    return None


def measures(stages, pe, steps, finish_ms):
    """The numbers the baseline is scored on. None where the run did not get that far."""
    st = {s['stage']: s for s in stages}
    g = {s['step']: s for s in steps}
    def acc(name):
        s = g.get(name)
        return None if s is None else s['accepted']
    def share(name):
        s = g.get(name)
        return None if s is None or not s['proposed'] else s['accepted'] / s['proposed']
    grammar = st.get('grammar', {})
    degraded = [s['stage'] for s in stages if s['status'] == 'degraded' and s['stage'] != 'finish']
    check = (pe or {}).get('check') or {}
    return {
        'finishMs': finish_ms,
        'pipelineGRan': bool(steps) and grammar.get('status') == 'committed',
        'massingOk': check.get('ok') if check else (None if pe is None else False),
        'massingIoU': check.get('iou'),
        'massingRoofErrM': check.get('heightErrMedianM'),
        'degradedStages': degraded,
        'degradedCount': len(degraded),
        'triangles': grammar.get('triangles'),
        'wallPlatesRead': acc('wall plates'),
        'facadeReadings': acc('facade reading'),
        'nativeBuildShare': share('native build'),
        'facesPainted': acc('paint'),
        'facadeTexturesShare': share('facade textures'),
        'roofTextures': acc('roof texture'),
    }


def verdicts(m, base):
    """Each baseline measure: met when the run is at least as good (direction per measure)."""
    out = []
    rules = [
        ('pipelineGRan', 'eq', 'pipeline G ran and committed'),
        ('massingOk', 'eq', 'massing passed its scan check'),
        ('degradedCount', 'le', 'degraded stages'),
        ('triangles', 'ge', 'triangles committed by the grammar stage'),
        ('wallPlatesRead', 'ge', 'wall plates read'),
        ('nativeBuildShare', 'ge', 'share of proposed elements the native build kept'),
        ('facadeTexturesShare', 'ge', 'share of facade textures accepted'),
        ('roofTextures', 'ge', 'roof textures accepted'),
    ]
    for key, how, label in rules:
        have, want = m.get(key), base.get(key)
        if have is None or want is None:
            out.append((key, 'n/a', label, have, want))
            continue
        ok = (have == want) if how == 'eq' else (have <= want) if how == 'le' else (have >= want)
        out.append((key, 'met' if ok else 'BELOW', label, have, want))
    return out


def fmt(v):
    if isinstance(v, float):
        return f'{v:.2f}'
    return str(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run', nargs='?')
    ap.add_argument('--wait', action='store_true')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--runs')
    a = ap.parse_args()
    runs_dir = find_runs_dir(a.runs)
    run_id = pick_run(runs_dir, a.run)
    run_dir = os.path.join(runs_dir, run_id)
    if a.wait:
        while not finished(run_dir):
            time.sleep(10)
    rows = read_timeline(run_dir)
    stages = stage_table(rows)
    finish = next((r for r in rows if r.get('stage') == 'finish'), None)
    pe = load_json(os.path.join(run_dir, 'pipeline_e.json'))
    pg = load_json(os.path.join(run_dir, 'pipeline_g.json'))
    st = load_json(os.path.join(run_dir, 'stages.json')) or {}
    steps = g_steps(pg)
    base = load_json(BASELINE) or {}
    m = measures(stages, pe, steps, finish.get('ms') if finish else None)
    v = verdicts(m, base.get('measures', {}))
    nb = native_build_detail(steps)
    if a.json:
        print(json.dumps({'runId': run_id, 'request': st.get('request'), 'place': st.get('place'), 'finished': bool(finish), 'stages': stages, 'massing': pe, 'pipelineG': steps, 'nativeBuild': nb, 'measures': m, 'verdicts': v}, indent=1))
        return
    req = st.get('request', {})
    print(f"run {run_id}: {req.get('query')}  {'procedural' if req.get('procedural') else ''} {'isolate' if req.get('isolate') else ''}  -> {(st.get('place') or {}).get('formattedAddress', '')}")
    print(f"finished: {'yes' if finish else 'NO (still running)'}" + (f", {finish.get('status')} after {finish.get('ms', 0) / 1000:.0f} s" if finish else ''))
    print('\nstages:')
    for s in stages:
        if s['status'] == 'skipped' and not s['reason']:
            continue
        line = f"  {s['stage']:<14} {s['status']:<10} {(s['ms'] or 0) / 1000:7.1f} s"
        if s['cached']:
            line += '  cached'
        if s['triangles']:
            line += f"  {s['triangles']:,} tris"
        if s['reason']:
            line += f"\n{'':18}{s['reason'][:220]}"
        print(line)
    if pe:
        c = pe.get('check')
        if c:
            print(f"\nmassing check: {'ok' if c.get('ok') else 'FAILED'}  IoU {c.get('iou')}  roof {c.get('heightErrMedianM')} m off (median), {c.get('heightErrP90M')} m (p90)" + (f"\n  {c.get('reason')}" if c.get('reason') else ''))
        if pe.get('fellBack'):
            print(f"  pipeline E fell back: {pe.get('reason')}")
        for n in pe.get('notes', [])[:6]:
            print(f"  {n[:220]}")
    if steps:
        print('\npipeline G:')
        for s in steps:
            line = f"  {s['step']:<22} {fmt(s['accepted']):>5} / {fmt(s['proposed']):<5} {(s['ms'] or 0) / 1000:6.0f} s"
            if s['skipped']:
                line += f"  skipped: {s['skipped'][:160]}"
            print(line)
            for n in s['notes'][:4]:
                if 'rejected by the native tool' in n:
                    continue
                print(f"{'':6}{n[:200]}")
        if nb and nb['rejected']:
            print(f"  native build rejected {nb['rejected']} openings by reading group: {nb['byGroup']}")
    print(f"\nagainst the baseline ({base.get('name', '?')}):")
    for key, status, label, have, want in v:
        print(f"  {status:<6} {label}: {fmt(have)} (baseline {fmt(want)})")
    below = [x for x in v if x[1] == 'BELOW']
    print(f"\nverdict: {'MEETS the baseline' if not below else str(len(below)) + ' measure(s) below the baseline'}")


if __name__ == '__main__':
    main()
