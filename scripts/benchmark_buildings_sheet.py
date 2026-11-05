"""The building benchmark's labelled sheet, from <out>/sheet.json (written by scripts/benchmark_buildings.ts).

    python3 scripts/benchmark_buildings_sheet.py <out>   (Pillow)

One row per building; per side its four views and a caption: the outcome, hole share, untextured share, generated
share and build time, with the change against the first side when there are two. Writes <out>/sheet.jpg and
<out>/sheet.md (the same numbers as a table).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

VIEW_W, VIEW_H = 200, 250
CAPTION_H = 118
LABEL_W = 230
PAD = 10
BG = (246, 246, 244)
INK = (28, 28, 30)
MUTED = (110, 110, 116)
WORSE = (176, 32, 32)
BETTER = (24, 120, 60)


def font(size, bold=False):
    names = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
             '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']
    for n in names:
        if os.path.exists(n):
            try:
                return ImageFont.truetype(n, size)
            except OSError:
                pass
    return ImageFont.load_default()


def pct(v):
    return '—' if v is None else f'{v * 100:.2f}%'


def minutes(ms):
    return '—' if not ms else f'{ms / 60000:.1f} min'


def delta(a, b, scale=100, unit='pt', lower_better=True):
    """b against a, coloured: (text, colour)."""
    if a is None or b is None:
        return '', MUTED
    d = (b - a) * scale
    if abs(d) < 0.005:
        return ' (=)', MUTED
    worse = d > 0 if lower_better else d < 0
    return f' ({d:+.2f} {unit})', WORSE if worse else BETTER


def autocrop(v, margin=8):
    """The view cut to the building: everything that differs from the plain background (the corner pixel) plus a margin."""
    from PIL import ImageChops
    bg = Image.new('RGB', v.size, v.getpixel((0, 0)))
    box = ImageChops.difference(v, bg).convert('L').point(lambda x: 255 if x > 12 else 0).getbbox()
    if not box:
        return v
    l, t, r, b = box
    return v.crop((max(0, l - margin), max(0, t - margin), min(v.width, r + margin), min(v.height, b + margin)))


def wrap(draw, text, f, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if draw.textlength(t, font=f) <= width:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def main(out):
    manifest = json.load(open(os.path.join(out, 'sheet.json')))
    sides = manifest['sides']
    by = {(r['side'], r['place']['slug']): r for r in manifest['results']}
    slugs = [s for s in manifest['places'] if any((side, s) in by for side in sides)]
    if not slugs:
        print('no results yet: no sheet')
        return
    block_w = 4 * VIEW_W + 3 * 4
    W = PAD + LABEL_W + len(sides) * (block_w + PAD) + PAD
    head_h = 70
    row_h = VIEW_H + CAPTION_H + PAD
    H = head_h + len(slugs) * row_h + 56
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title, f_head, f_body, f_small = font(26, True), font(17, True), font(14), font(12)
    d.text((PAD, 12), 'Building benchmark: pipeline K, uncached', font=f_title, fill=INK)
    for i, side in enumerate(sides):
        rs = [r for r in manifest['results'] if r['side'] == side]
        commit = rs[0]['commit'][:8] if rs else '?'
        dirty = ' + uncommitted app code' if rs and rs[0].get('dirtyAppCode') else ''
        x = PAD + LABEL_W + i * (block_w + PAD)
        d.text((x, 46), f'{side} @ {commit}{dirty}', font=f_head, fill=INK)
    y = head_h
    md = ['| Building | Kind | Side | Outcome | Holes | Untextured | Generated | Build time | Run |', '|---|---|---|---|---|---|---|---|---|']
    for slug in slugs:
        first = next(by[(s, slug)] for s in sides if (s, slug) in by)
        place = first['place']
        d.text((PAD, y + 4), place['name'], font=f_head, fill=INK)
        ly = y + 28
        for line in wrap(d, place['kind'], f_body, LABEL_W - 8):
            d.text((PAD, ly), line, font=f_body, fill=MUTED)
            ly += 18
        ly += 4
        addr = first.get('resolvedAddress') or place['query']
        for line in wrap(d, addr, f_small, LABEL_W - 8)[:4]:
            d.text((PAD, ly), line, font=f_small, fill=MUTED)
            ly += 15
        base = by.get((sides[0], slug))
        for i, side in enumerate(sides):
            x = PAD + LABEL_W + i * (block_w + PAD)
            r = by.get((side, slug))
            if not r:
                d.rectangle([x, y, x + block_w, y + VIEW_H], outline=(200, 200, 200))
                d.text((x + 10, y + VIEW_H // 2), 'not built yet', font=f_body, fill=MUTED)
                continue
            rdir = os.path.join(out, side, slug)
            views = {v['headingDeg']: os.path.join(rdir, v['png']) for v in r.get('views', [])}
            for k, h in enumerate([45, 135, 225, 315]):
                vx = x + k * (VIEW_W + 4)
                p = views.get(h)
                if p and os.path.exists(p):
                    v = autocrop(Image.open(p).convert('RGB'))
                    v.thumbnail((VIEW_W, VIEW_H))
                    img.paste(v, (vx + (VIEW_W - v.width) // 2, y + (VIEW_H - v.height) // 2))
                else:
                    d.rectangle([vx, y, vx + VIEW_W, y + VIEW_H], outline=(200, 200, 200))
                    d.text((vx + 8, y + 8), 'no view', font=f_small, fill=MUTED)
                d.text((vx + 4, y + VIEW_H - 16), f'{h}°', font=f_small, fill=MUTED)
            cy = y + VIEW_H + 4
            gen = (r.get('generated') or {}).get('share')
            outcome = r['outcome'] + ('' if r.get('cacheEmptiedBeforeBuild') else ' (NOT uncached)')
            d.text((x, cy), f"{outcome}   run {r.get('runId') or '—'}   {r.get('triangles') or 0:,} triangles", font=f_body, fill=WORSE if r['outcome'] == 'failed' else INK)
            cy += 20
            parts = [('holes', r.get('holeShare')), ('untextured', r.get('untexturedShare')), ('generated', gen)]
            cx = x
            for name, v in parts:
                t = f'{name} {pct(v)}'
                d.text((cx, cy), t, font=f_head, fill=INK)
                cx += d.textlength(t, font=f_head)
                if base is not r and base is not None:
                    bv = base.get('holeShare') if name == 'holes' else base.get('untexturedShare') if name == 'untextured' else (base.get('generated') or {}).get('share')
                    dt, col = delta(bv, v)
                    d.text((cx, cy + 2), dt, font=f_small, fill=col)
                    cx += d.textlength(dt, font=f_small)
                cx += 18
            cy += 24
            t = f"build {minutes(r.get('buildMs'))}   worst view: holes {pct(r.get('maxViewHoleShare'))}, untextured {pct(r.get('maxViewUntexturedShare'))}   largest hole {r.get('largestHoleRegionM2') or 0:.0f} m²"
            d.text((x, cy), t, font=f_body, fill=INK)
            if base is not r and base is not None:
                dt, col = delta(base.get('buildMs'), r.get('buildMs'), scale=1 / 60000, unit='min')
                d.text((x + d.textlength(t, font=f_body), cy + 1), dt, font=f_small, fill=col)
            cy += 20
            notes = r.get('reason') or '; '.join(r.get('degradations') or []) or (r.get('defectsWhy') or '')
            for line in wrap(d, notes, f_small, block_w)[:3]:
                d.text((x, cy), line, font=f_small, fill=MUTED)
                cy += 15
            md.append(f"| {place['name']} | {place['kind']} | {side} | {r['outcome']} | {pct(r.get('holeShare'))} | {pct(r.get('untexturedShare'))} | {pct(gen)} | {minutes(r.get('buildMs'))} | {r.get('runId') or '—'} |")
        y += row_h
        d.line([PAD, y - PAD // 2, W - PAD, y - PAD // 2], fill=(220, 220, 218))
    legend = ("Views look toward headings 45, 135, 225 and 315 at a 15-degree pitch, the texture as baked (path tracer). holes: building pixels showing a wall's back or the sky through it; untextured: pixels drawn with no photo (clay); "
              "both from the build's own outside check of the finished twin over all its views. generated: share of surface area whose colour "
              "is not a photo of that spot (filled photo holes, window repeats, base skirt, seal). Changes are against the first side.")
    ly = H - 50
    for line in wrap(d, legend, f_small, W - 2 * PAD):
        d.text((PAD, ly), line, font=f_small, fill=MUTED)
        ly += 15
    img.save(os.path.join(out, 'sheet.jpg'), quality=88)
    with open(os.path.join(out, 'sheet.md'), 'w') as fh:
        fh.write('\n'.join(md) + '\n')
    print(f"sheet: {os.path.join(out, 'sheet.jpg')} ({len(slugs)} buildings, {len(sides)} side(s))")


if __name__ == '__main__':
    main(sys.argv[1])
