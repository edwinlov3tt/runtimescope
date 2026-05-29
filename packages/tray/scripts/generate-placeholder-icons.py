#!/usr/bin/env python3
"""Generate placeholder tray + app-bundle icons for the RuntimeScope tray.

Tray icons: monochrome (alpha-only — Tauri's `iconAsTemplate: true` mode lets
macOS tint them to match the menu bar's dark/light theme).
App-bundle icon: a black "scope" silhouette on transparent background; macOS
renders it at the system corner radius automatically.

This is the v1 placeholder per Phase Tauri-Tray brief P2. The project owner
swaps in a real icon for v1.1.
"""

import os
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
ROOT.mkdir(parents=True, exist_ok=True)


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def write_png(path: Path, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    """Write an RGBA PNG. `pixels[y][x] = (r,g,b,a)` with components in 0..255."""
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter byte = None
        for r, g, b, a in row:
            raw.extend((r, g, b, a))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    out = b"\x89PNG\r\n\x1a\n"
    out += png_chunk(b"IHDR", ihdr)
    out += png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += png_chunk(b"IEND", b"")
    path.write_bytes(out)


def in_circle(x: float, y: float, cx: float, cy: float, r: float) -> bool:
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def in_ring(x: float, y: float, cx: float, cy: float, r_outer: float, r_inner: float) -> bool:
    return in_circle(x, y, cx, cy, r_outer) and not in_circle(x, y, cx, cy, r_inner)


def draw_scope(size: int, template: bool) -> list[list[tuple[int, int, int, int]]]:
    """A monochrome "scope" silhouette: outer ring + crosshair + center dot.

    `template=True` → black pixels with alpha only (macOS template image).
    `template=False` → black on transparent background (used for app icon).
    """
    pixels: list[list[tuple[int, int, int, int]]] = []
    cx = cy = (size - 1) / 2
    # Outer ring takes the outermost ~14% of the radius.
    r_outer = size / 2 - max(1, size / 16)
    r_inner = r_outer - max(1, size / 8)
    # Crosshair: 2 px wide at 16, scaling up.
    half_arm = max(1, size // 16)
    arm_reach = size / 2 - max(1, size / 32)
    center_dot_r = max(1, size // 8)
    for y in range(size):
        row: list[tuple[int, int, int, int]] = []
        for x in range(size):
            fx, fy = x + 0.5, y + 0.5
            is_mark = False
            if in_ring(fx, fy, cx, cy, r_outer, r_inner):
                is_mark = True
            elif abs(fx - cx) <= half_arm and abs(fy - cy) <= arm_reach:
                # vertical crosshair
                if not in_circle(fx, fy, cx, cy, r_inner - max(1, size / 12)):
                    is_mark = True
            elif abs(fy - cy) <= half_arm and abs(fx - cx) <= arm_reach:
                # horizontal crosshair
                if not in_circle(fx, fy, cx, cy, r_inner - max(1, size / 12)):
                    is_mark = True
            elif in_circle(fx, fy, cx, cy, center_dot_r):
                is_mark = True
            if is_mark:
                # Template images: black with full alpha (macOS tints these).
                row.append((0, 0, 0, 255))
            else:
                row.append((0, 0, 0, 0))
        pixels.append(row)
    _ = template  # Kept for symmetry; both template + bundle use black-on-clear.
    return pixels


def main() -> None:
    # Tray icons. macOS wants a 1x + a @2x; we add 22x22 because some macOS
    # menu-bar heights ask for it. Templates are alpha-only black.
    for size, name in [
        (16, "tray-icon.png"),
        (22, "tray-icon-22.png"),
        (32, "tray-icon@2x.png"),
    ]:
        write_png(ROOT / name, draw_scope(size, template=True))

    # App-bundle icon. The Tauri bundler picks up `icons/icon.png` as the
    # canonical source and re-derives the rest of the bundle sizes from it.
    # 512px is a safe canonical size for that workflow.
    write_png(ROOT / "icon.png", draw_scope(512, template=False))

    # Tauri also looks for these conventional alternate icons during bundling
    # on macOS / Windows / Linux. We supply them all from the same draw_scope
    # source so the user sees one identity everywhere.
    for size, name in [
        (32, "32x32.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
    ]:
        write_png(ROOT / name, draw_scope(size, template=False))

    print(f"Wrote placeholder icons to {ROOT}")
    for entry in sorted(os.listdir(ROOT)):
        path = ROOT / entry
        print(f"  {entry} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
