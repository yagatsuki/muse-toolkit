#!/usr/bin/env python3
"""Trim transparent pixels (folge.me/tools/trim-transparent-pixels equivalent).

Crops an image to the bounding box of its non-transparent content.
folge.me's tool treats any pixel with alpha != 0 as content, but images that
come out of background removers carry stray near-zero-alpha noise pixels
(alpha 1-8) far from the object, which would hold the crop box open.
In the browser pipeline those pixels collapse to fully transparent, so this
tool first zeroes alpha <= --threshold (default 8) and then crops, which
reproduces the same result. --threshold 0 gives the literal folge.me rule.

Usage: trim_transparent.py INPUT OUTPUT [--threshold N] [--padding PX]
Output format follows the OUTPUT extension (webp is saved lossless).
"""
import sys, os
from PIL import Image

def main():
    args = sys.argv[1:]
    threshold, padding = 8, 0
    pos = []
    i = 0
    while i < len(args):
        if args[i] == '--threshold': threshold = int(args[i+1]); i += 2
        elif args[i] == '--padding': padding = int(args[i+1]); i += 2
        else: pos.append(args[i]); i += 1
    src, out = pos[0], pos[1]
    im = Image.open(src).convert('RGBA')
    if threshold > 0:
        alpha = im.getchannel('A').point(lambda a: 0 if a <= threshold else a)
        im.putalpha(alpha)
    bbox = im.getchannel('A').getbbox()
    if bbox is None:
        print('image is fully transparent'); sys.exit(1)
    l, t, r, b = bbox
    l = max(0, l - padding); t = max(0, t - padding)
    r = min(im.width, r + padding); b = min(im.height, b + padding)
    im = im.crop((l, t, r, b))
    kw = {'lossless': True} if out.lower().endswith('.webp') else {}
    im.save(out, **kw)
    print(f'{src} -> {out}: {im.size[0]}x{im.size[1]} (bbox {l},{t},{r},{b}, threshold {threshold})')

if __name__ == '__main__':
    main()
