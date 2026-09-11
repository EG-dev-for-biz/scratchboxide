import os
import math
from PIL import Image, ImageDraw, ImageFont

def create_scratchbox_icon(size):
    # Create high-res canvas with supersampling for crisp edges
    scale = 4
    canvas_size = size * scale
    img = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = int(canvas_size * 0.08)
    rect_box = [margin, margin, canvas_size - margin, canvas_size - margin]
    radius = int(canvas_size * 0.22)

    # Gradient background for the rounded box
    # Draw vertical linear gradient from #3B82F6 (59, 130, 246) to #1D4ED8 (29, 78, 216)
    grad_img = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    grad_draw = ImageDraw.Draw(grad_img)

    for y in range(canvas_size):
        t = y / float(canvas_size)
        r = int(59 * (1 - t) + 29 * t)
        g = int(130 * (1 - t) + 78 * t)
        b = int(246 * (1 - t) + 216 * t)
        grad_draw.line([(0, y), (canvas_size, y)], fill=(r, g, b, 255))

    # Mask for rounded rectangle
    mask = Image.new("L", (canvas_size, canvas_size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(rect_box, radius=radius, fill=255)

    # Apply gradient mask
    base_box = Image.composite(grad_img, Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0)), mask)
    img = Image.alpha_composite(img, base_box)
    draw = ImageDraw.Draw(img)

    # Draw subtle glossy top highlight
    highlight_mask = Image.new("L", (canvas_size, canvas_size), 0)
    hl_draw = ImageDraw.Draw(highlight_mask)
    hl_box = [margin + int(scale * 2), margin + int(scale * 2), canvas_size - margin - int(scale * 2), int(canvas_size * 0.5)]
    hl_draw.rounded_rectangle(hl_box, radius=radius - int(scale * 2), fill=70)
    hl_overlay = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 0))
    img = Image.alpha_composite(img, Image.composite(Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 40)), Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0)), highlight_mask))
    draw = ImageDraw.Draw(img)

    # Code / Sandbox glyph: < / >
    stroke_w = max(int(scale * size * 0.075), 2 * scale)
    cx = canvas_size / 2
    cy = canvas_size / 2
    bracket_span = canvas_size * 0.22
    bracket_h = canvas_size * 0.26

    # Left bracket <
    p1 = (cx - bracket_span * 0.4, cy - bracket_h)
    p2 = (cx - bracket_span * 1.5, cy)
    p3 = (cx - bracket_span * 0.4, cy + bracket_h)
    draw.line([p1, p2, p3], fill=(255, 255, 255, 255), width=stroke_w, joint="round")

    # Right bracket >
    p4 = (cx + bracket_span * 0.4, cy - bracket_h)
    p5 = (cx + bracket_span * 1.5, cy)
    p6 = (cx + bracket_span * 0.4, cy + bracket_h)
    draw.line([p4, p5, p6], fill=(255, 255, 255, 255), width=stroke_w, joint="round")

    # Center slash /
    slash_p1 = (cx + bracket_span * 0.35, cy - bracket_h * 1.1)
    slash_p2 = (cx - bracket_span * 0.35, cy + bracket_h * 1.1)
    draw.line([slash_p1, slash_p2], fill=(191, 219, 254, 255), width=int(stroke_w * 0.9))

    # Resize down with high quality Lanczos antialiasing
    final_img = img.resize((size, size), Image.Resampling.LANCZOS)
    return final_img

def create_sidebar_bmp(width=164, height=314):
    img = Image.new("RGB", (width, height), (15, 23, 42)) # #0f172a dark slate
    draw = ImageDraw.Draw(img)

    # Draw gradient header
    for y in range(height):
        t = y / float(height)
        r = int(15 * (1 - t) + 30 * t)
        g = int(23 * (1 - t) + 58 * t)
        b = int(42 * (1 - t) + 138 * t)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    # Center small scratchbox icon
    icon = create_scratchbox_icon(80)
    icon_rgb = Image.new("RGB", icon.size, (20, 35, 75))
    icon_rgb.paste(icon, mask=icon.split()[3])
    img.paste(icon_rgb, (int((width - 80) / 2), 60))

    return img

def main():
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    
    # 1. Product extension icons
    icon_512 = create_scratchbox_icon(512)
    prod_icons_dir = os.path.join(root_dir, 'extensions/product/src/browser/icons')
    os.makedirs(prod_icons_dir, exist_ok=True)
    icon_512.save(os.path.join(prod_icons_dir, '512-512.png'), format="PNG")
    icon_512.save(os.path.join(prod_icons_dir, 'ScratchboxIDE.png'), format="PNG")

    # 2. Project logo directory
    logo_dir = os.path.join(root_dir, 'ScratchboxIDE logo')
    os.makedirs(logo_dir, exist_ok=True)
    icon_512.save(os.path.join(logo_dir, 'ScratchboxIDE.png'), format="PNG")

    # 3. Window and Linux launcher icons
    electron_res = os.path.join(root_dir, 'applications/electron/resources')
    window_icon_dir = os.path.join(electron_res, 'icons/WindowIcon')
    linux_icon_dir = os.path.join(electron_res, 'icons/LinuxLauncherIcons')
    os.makedirs(window_icon_dir, exist_ok=True)
    os.makedirs(linux_icon_dir, exist_ok=True)

    icon_512.save(os.path.join(window_icon_dir, '512-512.png'), format="PNG")
    icon_512.save(os.path.join(linux_icon_dir, '512x512.png'), format="PNG")
    icon_512.save(os.path.join(electron_res, 'icons/512x512.png'), format="PNG")

    # 4. Windows ICO generation (multi-resolution)
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_images = [create_scratchbox_icon(s[0]) for s in ico_sizes]
    
    win_icon_dir = os.path.join(electron_res, 'icons/WindowsLauncherIcon')
    os.makedirs(win_icon_dir, exist_ok=True)
    
    ico_images[-1].save(
        os.path.join(win_icon_dir, 'ScratchboxIDE.ico'),
        format="ICO",
        sizes=ico_sizes,
        append_images=ico_images[:-1]
    )
    ico_images[-1].save(
        os.path.join(electron_res, 'icon.ico'),
        format="ICO",
        sizes=ico_sizes,
        append_images=ico_images[:-1]
    )

    # 5. Browser Favicon
    browser_ico_dir = os.path.join(root_dir, 'applications/browser/ico')
    os.makedirs(browser_ico_dir, exist_ok=True)
    ico_images[-1].save(
        os.path.join(browser_ico_dir, 'favicon.ico'),
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[ico_images[0], ico_images[2], ico_images[3]]
    )

    # 6. Windows installer sidebar BMP
    bmp = create_sidebar_bmp(164, 314)
    sidebar_dir = os.path.join(electron_res, 'icons/InstallerSidebarImage')
    os.makedirs(sidebar_dir, exist_ok=True)
    bmp.save(os.path.join(sidebar_dir, '164-314Windows.bmp'), format="BMP")
    bmp.save(os.path.join(sidebar_dir, '164-314IOS.bmp'), format="BMP")
    bmp.save(os.path.join(electron_res, 'installerSidebar.bmp'), format="BMP")

    # 7. macOS iconset and ICNS using iconutil
    iconset_dir = os.path.join(electron_res, 'Scratchbox.iconset')
    os.makedirs(iconset_dir, exist_ok=True)

    mac_sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]

    for s, name in mac_sizes:
        icon_img = create_scratchbox_icon(s)
        icon_img.save(os.path.join(iconset_dir, name), format="PNG")

    mac_icon_dir = os.path.join(electron_res, 'icons/MacLauncherIcon')
    os.makedirs(mac_icon_dir, exist_ok=True)

    icns_out_1 = os.path.join(mac_icon_dir, '512-512-2.icns')
    icns_out_2 = os.path.join(electron_res, 'icon.icns')
    
    os.system(f"iconutil -c icns '{iconset_dir}' -o '{icns_out_1}'")
    os.system(f"cp '{icns_out_1}' '{icns_out_2}'")
    os.system(f"rm -rf '{iconset_dir}'")

    print("All Scratchbox icons and bitmaps generated successfully!")

if __name__ == '__main__':
    main()
