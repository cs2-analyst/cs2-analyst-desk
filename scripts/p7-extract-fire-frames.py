"""Extract a small transparent atlas from the user-supplied reference (Pillow, build-time only).
Usage: python scripts/p7-extract-fire-frames.py <reference.png>
The clean upper grid is used; the preview checkerboard/watermark is never copied.
"""
import hashlib
import json
import sys
from pathlib import Path
from collections import deque
from PIL import Image

source = Path(sys.argv[1])
im = Image.open(source).convert('RGB')
assert im.size == (700, 985), 'Unexpected reference dimensions'
# Six red/orange silhouettes, ordered around the grid; yellow-only icons are excluded
# to avoid whole-fire brightness flashes. All frames share an aligned ground baseline.
boxes = [(202, 76, 279, 181), (305, 78, 392, 181), (419, 73, 499, 182),
         (305, 188, 393, 287), (303, 290, 393, 388), (201, 287, 281, 388),
         (202, 187, 281, 286)]
atlas = Image.new('RGBA', (80 * len(boxes), 112))
for index, box in enumerate(boxes):
    crop = im.crop(box).convert('RGBA')
    pixels = crop.load()
    mask = {(x,y) for y in range(crop.height) for x in range(crop.width)
            if pixels[x,y][0] > 120 and pixels[x,y][0] - pixels[x,y][2] > 65}
    components = []
    while mask:
        first = mask.pop()
        group, queue = {first}, deque([first])
        while queue:
            x,y = queue.popleft()
            for p in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if p in mask:
                    mask.remove(p); group.add(p); queue.append(p)
        if len(group) > 30:
            components.extend(group)
    keep = {(x+dx,y+dy) for x,y in components for dx in (-1,0,1) for dy in (-1,0,1)}
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b, _ = pixels[x, y]
            # Flames are red/yellow; neutral paper is removed. Unmatte white AA edges.
            a = min(1.0, max(0.0, (r - b - 20) / 90)) if r > 100 and (x,y) in keep else 0
            if a > 0:
                pixels[x, y] = tuple(round(max(0, min(255, (c - 255*(1-a))/a))) for c in (r,g,b)) + (round(a*255),)
            else:
                pixels[x, y] = (0, 0, 0, 0)
    bounds = crop.getbbox()
    assert bounds
    crop = crop.crop(bounds)
    crop.thumbnail((72, 102), Image.Resampling.LANCZOS)
    atlas.alpha_composite(crop, (index*80+(80-crop.width)//2, 108-crop.height))
out = Path(__file__).resolve().parents[1] / 'apps/desktop/renderer/src/assets/replay-effects'
out.mkdir(parents=True, exist_ok=True)
atlas.save(out / 'fire-atlas.png', optimize=True)
(out / 'provenance.json').write_text(json.dumps({
    'source': 'User-provided fire sprite reference, 2026-10-18',
    'referenceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'cropBoxes': boxes, 'frameWidth': 80, 'frameHeight': 112, 'frames': len(boxes),
    'processing': 'Upper clean grid; saturation alpha mask; white-edge unmatting; common baseline; no checkerboard or watermark region',
    'atlasSha256': hashlib.sha256((out / 'fire-atlas.png').read_bytes()).hexdigest(),
}, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(out / 'fire-atlas.png')
