"""生成 Tauri 所需的图标集（PNG 多尺寸 + ICO）。"""
import os
import struct
import sys
import zlib


def rounded_rect_alpha(x, y, size, radius):
    cx = min(x, size - 1 - x)
    cy = min(y, size - 1 - y)
    if cx >= radius or cy >= radius:
        return True
    dx = radius - cx
    dy = radius - cy
    return dx * dx + dy * dy <= radius * radius


def pixel(x, y, size):
    """返回 (r,g,b,a)"""
    if not rounded_rect_alpha(x, y, size, int(size * 0.219)):
        return (0, 0, 0, 0)

    u = x / size
    v = y / size

    # 背景渐变
    t = (u + v) / 2.0
    r = int(0x16 + (0x4C - 0x16) * t)
    g = int(0x77 + (0x9A - 0x77) * t)
    b = 0xFF

    # 字母 M 笔画
    def in_m():
        if not (0.28 <= u <= 0.72 and 0.26 <= v <= 0.74):
            return False
        lw = 0.088
        if 0.28 <= u <= 0.28 + lw:
            return True
        if 0.72 - lw <= u <= 0.72:
            return True
        # 左斜线
        d1 = abs((v - 0.26) - (u - 0.28) * (0.24 / 0.22))
        if d1 < 0.058 and 0.28 <= u <= 0.52 and v >= 0.26:
            return True
        # 右斜线
        d2 = abs((v - 0.26) - (0.72 - u) * (0.24 / 0.22))
        if d2 < 0.058 and 0.48 <= u <= 0.72 and v >= 0.26:
            return True
        return False

    if in_m():
        return (255, 255, 255, 255)
    return (r, g, b, 255)


def make_png(size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row.extend(pixel(x, y, size))
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


def make_ico(pngs):
    """将多张 PNG 打包为 ICO（PNG 压缩格式，Vista+ 支持）"""
    count = len(pngs)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    offset = 6 + 16 * count
    data = b""
    for size, png in pngs:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
        data += png
    return header + entries + data


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icons"
    os.makedirs(out, exist_ok=True)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    cache = {}
    for s in sizes:
        png = make_png(s)
        cache[s] = png
        print(f"{out}/{s}x{s}.png  {len(png)} bytes")
        with open(os.path.join(out, f"{s}x{s}.png"), "wb") as f:
            f.write(png)

    # Tauri 约定的命名
    with open(os.path.join(out, "32x32.png"), "wb") as f:
        f.write(cache[32])
    with open(os.path.join(out, "128x128.png"), "wb") as f:
        f.write(cache[128])
    with open(os.path.join(out, "128x128@2x.png"), "wb") as f:
        f.write(cache[256])
    with open(os.path.join(out, "icon.png"), "wb") as f:
        f.write(cache[512])

    ico = make_ico([(16, cache[16]), (24, cache[24]), (32, cache[32]),
                    (48, cache[48]), (64, cache[64]), (128, cache[128]),
                    (256, cache[256])])
    with open(os.path.join(out, "icon.ico"), "wb") as f:
        f.write(ico)
    print(f"{out}/icon.ico  {len(ico)} bytes")

    # Windows Store 图标
    for name, s in [("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
                    ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
                    ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
                    ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
                    ("Square310x310Logo.png", 310), ("StoreLogo.png", 50)]:
        with open(os.path.join(out, name), "wb") as f:
            f.write(make_png(s))


if __name__ == "__main__":
    main()
