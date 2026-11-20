"""Plan 116 photo processor (Pillow adapter). Run with `python3 -I`.

Usage: pillow_worker.py <input> <out_dir> <base_name> <widths comma list>
Writes <out_dir>/<base_name>-w<width>.webp for each width <= the image width (no upscaling)
and prints one JSON object: dimensions, variants, a 9x8 grayscale buffer (dHash) and a small
RGB buffer (BlurHash + dominant colour), both base64.
"""

import base64
import json
import os
import sys

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 120_000_000


def main() -> None:
    src, out_dir, base, widths = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        w, h = im.size
        os.makedirs(out_dir, exist_ok=True)
        variants = []
        for tw in sorted({int(x) for x in widths.split(",") if x}):
            if tw > w:
                continue
            th = max(1, round(h * tw / w))
            v = im if tw == w else im.resize((tw, th), Image.LANCZOS)
            path = os.path.join(out_dir, f"{base}-w{tw}.webp")
            v.save(path + ".part", "WEBP", quality=78, method=4)
            os.replace(path + ".part", path)
            variants.append({"label": f"w{tw}", "width": tw, "height": th, "path": path, "bytes": os.path.getsize(path)})
        gray = im.convert("L").resize((9, 8), Image.BOX).tobytes()
        sw = 32 if w >= h else max(1, round(32 * w / h))
        sh = max(1, round(sw * h / w)) if w >= h else 32
        small = im.resize((sw, sh), Image.BOX).tobytes()
    print(
        json.dumps(
            {
                "width": w,
                "height": h,
                "variants": variants,
                "gray9x8": base64.b64encode(gray).decode(),
                "small": {"width": sw, "height": sh, "rgb": base64.b64encode(small).decode()},
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # reported to the caller as a decode failure
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(2)
