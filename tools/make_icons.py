"""生成 PWA 所需的图标（在 app 目录下运行）。"""
import os
import struct
import sys
import zlib


def make_png(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            radius = int(size * 0.219)
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            inside = True
            if cx < radius and cy < radius:
                dx = radius - cx
                dy = radius - cy
                if dx * dx + dy * dy > radius * radius:
                    inside = False
            if not inside:
                row.extend((0, 0, 0, 0))
                continue

            u = x / size
            v = y / size
            t = (u + v) / 2.0
            r = int(0x16 + (0x4C - 0x16) * t)
            g = int(0x77 + (0x9A - 0x77) * t)
            b = 0xFF

            in_m = False
            if 0.28 <= u <= 0.72 and 0.26 <= v <= 0.74:
                lw = 0.088
                if 0.28 <= u <= 0.28 + lw:
                    in_m = True
                if 0.72 - lw <= u <= 0.72:
                    in_m = True
                d1 = abs((v - 0.26) - (u - 0.28) * (0.24 / 0.22))
                if d1 < 0.058 and 0.28 <= u <= 0.52 and v >= 0.26:
                    in_m = True
                d2 = abs((v - 0.26) - (0.72 - u) * (0.24 / 0.22))
                if d2 < 0.058 and 0.48 <= u <= 0.72 and v >= 0.26:
                    in_m = True

            row.extend((255, 255, 255, 255) if in_m else (r, g, b, 255))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "public/icons"
    os.makedirs(out, exist_ok=True)
    for size in (192, 512):
        path = os.path.join(out, f"icon-{size}.png")
        data = make_png(size)
        with open(path, "wb") as f:
            f.write(data)
        print(f"{path}  {len(data)} bytes")


if __name__ == "__main__":
    main()
