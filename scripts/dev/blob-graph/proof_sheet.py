"""Blob graph prototype (dev tool): the labelled proof sheet.

    python3 -I scripts/dev/blob-graph/proof_sheet.py <out dir> <cards.json> <sheet.png>

Reads <out>/blob_graph.json and the renders. cards.json: {"cards": [blob index, ...], "title": "...", "stats": {...}}.
Panels: (1) the district from above coloured by treatment group, with a legend, beside the photo-textured view;
(2) the blob cards (photo view, clay view, the reading in one line, its confidence, the judge's yes/no, the spot check);
(3) the counts table, the unassigned share, agreement with the spot checks, model calls, cost and time.
"""
import json
import os
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

GROUP_COLOURS = {
    "ground": (0.35, 0.35, 0.35), "building": (0.55, 0.62, 0.75), "roof-object": (0.95, 0.55, 0.05), "wall-attachment": (0.85, 0.1, 0.6),
    "tree": (0.1, 0.7, 0.15), "transient-candidate": (0.95, 0.9, 0.05), "ground-object": (0.05, 0.75, 0.95), "unassigned": (1.0, 0.0, 0.0),
}


def font(size, bold=False):
    names = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] if bold else []
    names += ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]
    for f in names:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def fit(im, w, h):
    im = im.convert("RGB")
    s = min(w / im.width, h / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def main():
    out, cards_path, sheet_path = sys.argv[1:4]
    g = json.load(open(os.path.join(out, "blob_graph.json")))
    cfg = json.load(open(cards_path))
    blobs = g["blobs"]
    W = 2400
    T, H1, H2, H3 = font(40, True), font(26, True), font(17), font(15)
    # panel 1
    ov = fit(Image.open(os.path.join(out, "overview_groups.png")), 980, 980)
    ph = fit(Image.open(os.path.join(out, "overview_photo.png")), 980, 980)
    cols, card_w, card_h = 6, 385, 330
    rows = (len(cfg["cards"]) + cols - 1) // cols
    p1h, p2h, p3h = ov.height + 90, rows * (card_h + 12) + 70, 760
    sheet = Image.new("RGB", (W, 110 + p1h + p2h + p3h), (250, 250, 248))
    d = ImageDraw.Draw(sheet)
    d.text((30, 25), cfg["title"], font=T, fill=(20, 20, 20))
    d.text((30, 75), cfg.get("subtitle", ""), font=H2, fill=(80, 80, 80))
    y0 = 110
    d.text((30, y0), "1  The district from above, coloured by treatment group (left), and photo-textured (right); north up", font=H1, fill=(20, 20, 20))
    sheet.paste(ov, (30, y0 + 45))
    sheet.paste(ph, (30 + ov.width + 20, y0 + 45))
    lx = 30 + ov.width + 20 + ph.width + 30
    ly = y0 + 60
    counts = g["counts"]["groups"]
    for name, c in GROUP_COLOURS.items():
        rgb = tuple(int(255 * v) for v in c)
        d.rectangle([lx, ly, lx + 34, ly + 26], fill=rgb, outline=(0, 0, 0))
        n = counts.get(name, {}).get("blobs", g["counts"]["unassignedTriangles"] and 0)
        label = name if name != "unassigned" else "unassigned (red)"
        d.text((lx + 46, ly + 2), f"{label}" + (f"  ({counts[name]['blobs']})" if name in counts else ""), font=H2, fill=(20, 20, 20))
        ly += 40
    d.multiline_text((lx, ly + 20), "\n".join(textwrap.wrap(cfg.get("legendNote", ""), 26)), font=H3, fill=(60, 60, 60), spacing=4)
    # panel 2
    y0 += p1h
    d.text((30, y0), "2  Blob cards: photo view | clay view, the reading, its confidence, the judge (held-out view) and my spot check where taken", font=H1, fill=(20, 20, 20))
    for k, bi in enumerate(cfg["cards"]):
        b = blobs[bi]
        cx, cy = 30 + (k % cols) * (card_w + 8), y0 + 50 + (k // cols) * (card_h + 12)
        d.rectangle([cx, cy, cx + card_w, cy + card_h], fill=(255, 255, 255), outline=(200, 200, 200))
        vd = os.path.join(out, "views", str(bi))
        for c, name in enumerate(["photo_45.png", "clay_45.png"]):
            p = os.path.join(vd, name)
            if os.path.exists(p):
                sheet.paste(fit(Image.open(p), 188, 188), (cx + 3 + c * 191, cy + 3))
        r = b.get("reading") or {}
        j = b.get("judge") or {}
        sc = b.get("spotCheck") or {}
        col = tuple(int(255 * v) for v in GROUP_COLOURS.get(b["group"], (0.5, 0.5, 0.5)))
        d.rectangle([cx + 3, cy + 195, cx + 17, cy + 209], fill=col)
        sz = b["measures"]["sizeM"]
        d.text((cx + 22, cy + 193), f"#{k + 1}  blob {bi}  {b['group']}  {sz[0]:.0f}x{sz[2]:.0f}x{sz[1]:.0f} m", font=H3, fill=(20, 20, 20))
        desc = r.get("description", "(not read)")
        d.multiline_text((cx + 5, cy + 214), "\n".join(textwrap.wrap(desc, 46)[:3]), font=H3, fill=(30, 30, 30), spacing=2)
        conf = r.get("confidence")
        jt = "judge: yes" if j.get("agree") is True else ("judge: NO" if j else "judge: -")
        line = f"conf {conf:.2f}  |  {jt}" if isinstance(conf, (int, float)) else jt
        if sc:
            line += f"  |  spot: {sc.get('verdict', '-')}"
        d.text((cx + 5, cy + 280), line, font=H3, fill=(0, 90, 0) if j.get("agree") is True else (170, 0, 0))
        note = cfg.get("notes", {}).get(str(bi), "")
        if note:
            d.text((cx + 5, cy + 302), note[:52], font=H3, fill=(90, 90, 160))
    # panel 3
    y0 += p2h
    d.text((30, y0), "3  Counts, unassigned share, agreement, model calls, cost and time", font=H1, fill=(20, 20, 20))
    hdr = ["group", "blobs", "triangles", "area m2", "share of area", "read", "judge agreed"]
    xs = [30, 300, 420, 580, 740, 920, 1020]
    yy = y0 + 50
    for x, h in zip(xs, hdr):
        d.text((x, yy), h, font=H2, fill=(20, 20, 20))
    yy += 34
    total = g["source"]["areaM2"]
    for name in ["ground", "building", "roof-object", "wall-attachment", "tree", "transient-candidate", "ground-object"]:
        c = counts.get(name)
        if not c:
            continue
        rb = [b for b in blobs if b["group"] == name]
        nread = sum(1 for b in rb if b.get("reading"))
        nj = sum(1 for b in rb if b.get("judge"))
        nag = sum(1 for b in rb if (b.get("judge") or {}).get("agree") is True)
        vals = [name, str(c["blobs"]), str(c["triangles"]), f"{c['areaM2']:.0f}", f"{100 * c['areaM2'] / total:.2f}%", str(nread), f"{nag}/{nj}"]
        for x, v in zip(xs, vals):
            d.text((x, yy), v, font=H2, fill=(30, 30, 30))
        yy += 32
    un = g["counts"]
    vals = ["unassigned", "-", str(un["unassignedTriangles"]), f"{un['unassignedAreaM2']:.1f}", f"{100 * un['unassignedShare']:.4f}%", "-", "-"]
    for x, v in zip(xs, vals):
        d.text((x, yy), v, font=H2, fill=(170, 0, 0))
    yy += 50
    d.multiline_text((30, yy), "\n".join(cfg.get("statsLines", [])), font=H2, fill=(20, 20, 20), spacing=8)
    d.multiline_text((1250, y0 + 50), "\n".join(cfg.get("findings", [])), font=H2, fill=(20, 20, 20), spacing=8)
    sheet.save(sheet_path)
    print(sheet_path, sheet.size)


if __name__ == "__main__":
    main()
