#!/usr/bin/env python3
"""Finish a product photo for catalog registration, in one pass:
background removal (rembg) -> trim transparent pixels -> lossless WebP.

Reproduces a manual workflow (remove background, trim to the outline,
compress) as a single script:
- Background removal runs rembg in its own venv (the models are heavy, so
  it stays a subprocess). Default model is isnet-general-use; u2netp is
  lighter but can leave parts of dark backdrop graphics attached to the
  subject, so check the result visually either way.
- Trimming follows the trim-transparent-pixels tool: pixels with alpha
  <= --threshold (default 8) count as transparent, which removes the
  near-zero alpha noise rembg leaves behind before cropping to the
  content bounds.
- Output is lossless WebP when the output name ends in .webp.

Usage: finish_image.py INPUT OUTPUT.webp [--model NAME]
       [--threshold N] [--rembg-python PATH]
The rembg python defaults to rembg-venv/bin/python next to this script;
override with --rembg-python or the REMBG_PY environment variable.
Models are cached under U2NET_HOME (default ~/.rembg).
"""
import os, subprocess, sys

def parse_args(argv):
    pos, opts = [], {'model': 'isnet-general-use', 'threshold': 8, 'rembg_python': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--model': opts['model'] = argv[i+1]; i += 2
        elif a == '--threshold': opts['threshold'] = int(argv[i+1]); i += 2
        elif a == '--rembg-python': opts['rembg_python'] = argv[i+1]; i += 2
        else: pos.append(a); i += 1
    return pos, opts

def main():
    pos, opts = parse_args(sys.argv[1:])
    if len(pos) != 2:
        print(__doc__); return 2
    src, out = pos
    here = os.path.dirname(os.path.abspath(__file__))
    rembg_py = (opts['rembg_python'] or os.environ.get('REMBG_PY')
                or os.path.join(here, 'rembg-venv', 'bin', 'python'))
    if not os.path.isfile(rembg_py):
        print(f'rembg python not found: {rembg_py}'); return 1
    tmp_cut = out + '.cut.png'
    code = (
        "import sys\n"
        "from rembg import new_session, remove\n"
        "from PIL import Image\n"
        "img = Image.open(sys.argv[1]).convert('RGB')\n"
        f"out = remove(img, session=new_session('{opts['model']}'))\n"
        "out.save(sys.argv[2])\n"
        "print('rembg ok', out.size, out.mode)\n"
    )
    env = dict(os.environ, U2NET_HOME=os.environ.get(
        'U2NET_HOME', os.path.expanduser('~/.rembg')))
    r = subprocess.run([rembg_py, '-c', code, src, tmp_cut],
                       capture_output=True, text=True, env=env, timeout=1200)
    print(r.stdout[-200:], r.stderr[-300:])
    if r.returncode != 0 or not os.path.exists(tmp_cut):
        print('background removal failed'); return 1
    from PIL import Image
    im = Image.open(tmp_cut).convert('RGBA')
    os.unlink(tmp_cut)
    th = opts['threshold']
    if th > 0:
        im.putalpha(im.getchannel('A').point(lambda a: 0 if a <= th else a))
    # Bounding box counts only majority-opaque pixels as content: faint
    # residue (alpha up to ~60) left where other objects (logos, badges)
    # were removed would otherwise hold the box open to the image edge.
    bbox = im.getchannel('A').point(lambda a: 255 if a > 128 else 0).getbbox()
    if bbox is None:
        print('image is fully transparent after removal'); return 1
    im = im.crop(bbox)
    kw = {'lossless': True} if out.lower().endswith('.webp') else {}
    im.save(out, **kw)
    print(f'saved: {out} {im.size[0]}x{im.size[1]} {os.path.getsize(out)} bytes')
    return 0

if __name__ == '__main__':
    sys.exit(main())
