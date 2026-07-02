#!/usr/bin/env python3
"""Generate the extension icons (PNG 16/32/48/128) with pure stdlib.

No PIL available in this environment, so PNGs are encoded manually:
RGBA scanlines with filter type 0, zlib-compressed, wrapped in
IHDR/IDAT/IEND chunks. The glyph — a white circular refresh arrow on a
flat blue disc — is rasterized per-pixel at 512x512 and box-downsampled
to each target size for cheap anti-aliasing. Fully deterministic; CI
verifies with --check.

Usage:
    python3 tools/generate_icons.py           # write assets/icons/icon*.png
    python3 tools/generate_icons.py --check   # verify checked-in files match
"""

import math
import struct
import sys
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "icons"
SIZES = [16, 32, 48, 128]
BASE = 512  # supersampled master resolution

BLUE = (26, 115, 232)  # #1A73E8
WHITE = (255, 255, 255)


def render_master():
    """Render the 512x512 RGBA master image as a flat list of pixels."""
    cx = cy = BASE / 2
    disc_r = BASE * 0.47
    ring_r = BASE * 0.26  # refresh-arc centerline radius
    ring_half = BASE * 0.055  # half thickness of the arc

    # The arc runs clockwise from 300deg around to 120deg (leaving a gap),
    # with an arrowhead at the arc's end. Angles measured in degrees,
    # standard math orientation (CCW positive, 0 = +x axis).
    gap_start, gap_end = 20, 80  # the arc is absent inside this sector

    # Arrowhead: solid triangle at the arc end (pointing clockwise/tangent).
    head_angle = math.radians(gap_end + 8)
    hx = cx + ring_r * math.cos(head_angle)
    hy = cy - ring_r * math.sin(head_angle)
    head_size = BASE * 0.14
    tangent = head_angle - math.pi / 2  # clockwise tangent direction
    tip = (hx + head_size * 0.9 * math.cos(tangent), hy - head_size * 0.9 * math.sin(tangent))
    left = (
        hx + head_size * 0.55 * math.cos(head_angle),
        hy - head_size * 0.55 * math.sin(head_angle),
    )
    right = (
        hx - head_size * 0.55 * math.cos(head_angle),
        hy + head_size * 0.55 * math.sin(head_angle),
    )
    tri = (tip, left, right)

    def in_triangle(px, py, tri):
        (x1, y1), (x2, y2), (x3, y3) = tri
        d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
        d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
        d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    pixels = []
    for y in range(BASE):
        for x in range(BASE):
            px, py = x + 0.5, y + 0.5
            dx, dy = px - cx, py - cy
            dist = math.hypot(dx, dy)
            if dist > disc_r:
                pixels.append((0, 0, 0, 0))  # transparent outside the disc
                continue
            color = BLUE
            # White refresh arc (annulus band outside the gap sector).
            if abs(dist - ring_r) <= ring_half:
                angle = math.degrees(math.atan2(-dy, dx)) % 360
                if not (gap_start <= angle <= gap_end):
                    color = WHITE
            # White arrowhead triangle.
            if in_triangle(px, py, tri):
                color = WHITE
            pixels.append((*color, 255))
    return pixels


def downsample(pixels, size):
    """Box-downsample the BASE master to size x size (BASE % size == 0)."""
    factor = BASE // size
    out = []
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(factor):
                for sx in range(factor):
                    pr, pg, pb, pa = pixels[(oy * factor + sy) * BASE + (ox * factor + sx)]
                    # premultiply so transparent samples don't tint edges
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = factor * factor
            if a == 0:
                out.append((0, 0, 0, 0))
            else:
                out.append((round(r / a), round(g / a), round(b / a), round(a / n)))
    return out


def png_bytes(pixels, size):
    def chunk(tag, data):
        raw = tag + data
        return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    scanlines = bytearray()
    for y in range(size):
        scanlines.append(0)  # filter type 0
        for x in range(size):
            scanlines += bytes(pixels[y * size + x])
    idat = zlib.compress(bytes(scanlines), 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def main():
    check = "--check" in sys.argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = render_master()
    failures = []
    for size in SIZES:
        data = png_bytes(downsample(master, size), size)
        path = OUT_DIR / f"icon{size}.png"
        if check:
            if not path.exists() or path.read_bytes() != data:
                failures.append(path.name)
            continue
        path.write_bytes(data)
        print(f"wrote {path} ({len(data)} bytes)")
    if check:
        if failures:
            print(f"MISMATCH: {', '.join(failures)} — rerun tools/generate_icons.py")
            sys.exit(1)
        print("icons OK")


if __name__ == "__main__":
    main()
