#!/usr/bin/env python3
"""
Scratchbox IDE Icon & Asset Generation Pipeline
Generates multi-resolution icon assets from the canonical impossible cube logo.
Can run via native C++ CoreGraphics engine (fast, macOS native) or PIL fallback.
"""

import os
import sys
import subprocess

def main():
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    canonical_img = os.path.join(root_dir, 'assets/brand/ScratchboxIDE.png')
    legacy_img = os.path.join(root_dir, 'ScratchboxIDE logo/ScratchboxIDE.png')
    source_img = canonical_img if os.path.exists(canonical_img) else legacy_img
    
    if not os.path.exists(source_img):
        print(f"Error: master source image not found at {source_img}", file=sys.stderr)
        sys.exit(1)

    cpp_src = os.path.join(root_dir, 'scripts/generate_icons.cpp')
    bin_path = os.path.join(root_dir, 'build/generate_icons')
    os.makedirs(os.path.join(root_dir, 'build'), exist_ok=True)

    if sys.platform == 'darwin' and os.path.exists(cpp_src):
        print("[Icon Pipeline] Compiling native Apple Clang C++20 asset generator...")
        compile_cmd = [
            'clang++', '-std=c++20', '-O3',
            '-framework', 'Foundation',
            '-framework', 'CoreGraphics',
            '-framework', 'ImageIO',
            '-framework', 'CoreServices',
            cpp_src, '-o', bin_path
        ]
        ret = subprocess.run(compile_cmd)
        if ret.returncode == 0:
            print("[Icon Pipeline] Executing native icon generation...")
            exec_ret = subprocess.run([bin_path, source_img, root_dir])
            if exec_ret.returncode == 0:
                print("[Icon Pipeline] Completed successfully via native engine!")
                return

    # Fallback to PIL if available
    try:
        from PIL import Image
    except ImportError:
        print("[Icon Pipeline] PIL not installed and native Clang pipeline skipped.", file=sys.stderr)
        sys.exit(1)

    print("[Icon Pipeline] Running PIL fallback generator...")
    src = Image.open(source_img).convert("RGBA")
    
    # 1. Primary destinations
    electron_res = os.path.join(root_dir, 'applications/electron/resources')
    os.makedirs(os.path.join(electron_res, 'icons/WindowIcon'), exist_ok=True)
    os.makedirs(os.path.join(electron_res, 'icons/LinuxLauncherIcons'), exist_ok=True)
    os.makedirs(os.path.join(electron_res, 'icons/WindowsLauncherIcon'), exist_ok=True)
    os.makedirs(os.path.join(electron_res, 'icons/MacLauncherIcon'), exist_ok=True)
    os.makedirs(os.path.join(root_dir, 'desktop-app/public/icons'), exist_ok=True)
    os.makedirs(os.path.join(root_dir, 'desktop-app/resources'), exist_ok=True)

    icon_512 = src.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save(os.path.join(electron_res, 'icons/WindowIcon/512-512.png'))
    icon_512.save(os.path.join(electron_res, 'icons/LinuxLauncherIcons/512x512.png'))
    icon_512.save(os.path.join(electron_res, 'icons/512x512.png'))
    icon_512.save(os.path.join(electron_res, 'icon.png'))
    icon_512.save(os.path.join(root_dir, 'desktop-app/public/icons/ScratchboxIDE.png'))
    icon_512.save(os.path.join(root_dir, 'desktop-app/resources/icon.png'))

    # ICO
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_imgs = [src.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_imgs[-1].save(os.path.join(electron_res, 'icon.ico'), format="ICO", sizes=ico_sizes, append_images=ico_imgs[:-1])
    ico_imgs[-1].save(os.path.join(root_dir, 'desktop-app/public/favicon.ico'), format="ICO", sizes=ico_sizes, append_images=ico_imgs[:-1])
    ico_imgs[-1].save(os.path.join(root_dir, 'desktop-app/resources/icon.ico'), format="ICO", sizes=ico_sizes, append_images=ico_imgs[:-1])

    print("All Scratchbox icons generated successfully!")

if __name__ == '__main__':
    main()
