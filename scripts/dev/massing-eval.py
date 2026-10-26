# ********************************************************************************
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
# ********************************************************************************
"""Massing evaluation, step 2 (dev tool): sb.massing.choose on every case massing-eval-prep.ts wrote, the chosen
massing written as <out>/<n>_chosen.glb and every candidate's numbers to <out>/report.json.

    .venv/bin/python -I scripts/dev/massing-eval.py <out-dir>     (PYTHONPATH: the engine build_py and src/python)
"""

import json
import os
import sys
import time

import scratchbox as sb


def main(out):
    cases = json.load(open(os.path.join(out, "cases.json")))
    report = []
    for n, c in enumerate(cases, 1):
        if c.get("roofPhoto"):
            os.environ["SCAN_ROOF_PHOTO_PATH"] = c["roofPhoto"]
            os.environ["SCAN_ROOF_PHOTO_FRAME"] = json.dumps(c["roofFrame"])
        else:
            os.environ.pop("SCAN_ROOF_PHOTO_PATH", None)
            os.environ.pop("SCAN_ROOF_PHOTO_FRAME", None)
        t = time.time()
        row = {"n": n, "place": c["place"], "runId": c["runId"], "planSource": c.get("planSource")}
        try:
            plan = [[tuple(p) for p in r] for r in c["plan"]] if c.get("plan") else None
            scan = sb.massing.Scan.load(c["scanGlb"], plan=plan, ground_y=c.get("groundY"), district=c.get("districtGlb"))
            choice = sb.massing.choose(scan)
            row.update({
                "chosen": choice.label, "explains": choice.explains, "why": choice.why,
                "candidates": choice.rows,
                "height": round(scan.top() - scan.ground_y, 1), "roofY": round(scan.roof_y(), 2), "samples": len(scan.samples),
            })
            roof = next((cand.roof for cand in choice_candidates(choice) if cand.roof), None)
            if roof:
                kinds = {}
                for o in roof["objects"]:
                    kinds[o["chosen"]] = kinds.get(o["chosen"], 0) + 1
                row["roof"] = {"objects": len(roof["objects"]), "kinds": kinds, "photo": roof["photo"],
                               "tallest": round(max((o["top_y"] - o["base_y"] for o in roof["objects"]), default=0), 1)}
            scene = sb.Scene()
            scene.add_mesh(choice.mesh)
            sb.io.write_glb(os.path.join(out, f"{n}_chosen.glb"), scene)
            row["chosenGlb"] = os.path.join(out, f"{n}_chosen.glb")
        except Exception as e:  # a case that cannot run is reported, not hidden
            row["error"] = f"{type(e).__name__}: {e}"
        row["seconds"] = round(time.time() - t, 1)
        report.append(row)
        print(f"{n}. {c['place'][:50]:50s} {row.get('chosen', 'ERROR')!s:22s} {row.get('error', '')[:80]}", flush=True)
    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=1)


def choice_candidates(choice):
    # the roof report rides on the "block + roof objects" candidate, whichever candidate won
    return choice.candidates


if __name__ == "__main__":
    main(sys.argv[1])
