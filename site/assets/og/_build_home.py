#!/usr/bin/env python3
"""
Regenerate site/assets/og/home.png — the 1200x630 Open Graph share
image used by Facebook, LinkedIn, X, iMessage, etc.

Design: full-bleed sunset shot of the Breezy EV fleet framing the
PCGC yard sign, cinematic dark-teal gradient across the bottom
half, cream Georgia serif headline, coral eyebrow + coral CTA pill
with URL and phone. Matches the brand palette (coral #e85a4f,
teal-dk #1f5a68, cream #fbf8f3).

Run from the repo root:  python3 site/assets/og/_build_home.py
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent.parent.parent  # repo root
SRC_PHOTO = ROOT / "site/assets/photos/sunset-carts-sign.jpg"
OUT = ROOT / "site/assets/og/home.png"

W, H = 1200, 630
CORAL = (232, 90, 79)
TEAL_DK = (31, 90, 104)
CREAM = (251, 248, 243)
INK = (34, 34, 34)


def cover_crop(img: Image.Image, w: int, h: int) -> Image.Image:
    """Scale + center-crop like CSS background-size: cover."""
    src_w, src_h = img.size
    src_ratio = src_w / src_h
    dst_ratio = w / h
    if src_ratio > dst_ratio:
        new_h = h
        new_w = int(src_ratio * new_h)
    else:
        new_w = w
        new_h = int(new_w / src_ratio)
    img2 = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - w) // 2
    top = (new_h - h) // 2
    return img2.crop((left, top, left + w, top + h))


def load_font(paths: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_pill(draw: ImageDraw.ImageDraw, xy, radius, fill):
    x1, y1, x2, y2 = xy
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def main():
    photo = Image.open(SRC_PHOTO).convert("RGB")
    base = cover_crop(photo, W, H)

    # Slight cinematic saturation boost + tiny sharpen
    from PIL import ImageEnhance
    base = ImageEnhance.Color(base).enhance(1.10)
    base = ImageEnhance.Contrast(base).enhance(1.05)

    # Bottom gradient overlay — dark teal fading up to transparent so
    # the top of the photo (sunset sky) stays vivid but the lower half
    # supports readable text. Built via a per-row alpha ramp.
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    grad_top = int(H * 0.42)
    for y in range(grad_top, H):
        t = (y - grad_top) / (H - grad_top)
        eased = t ** 1.5
        alpha = int(40 + eased * 215)  # 40..255 — hits opaque at bottom
        gdraw.line([(0, y), (W, y)], fill=(*TEAL_DK, alpha))
    # Top-of-frame dark bar so the eyebrow always reads over dark carts
    for y in range(0, int(H * 0.18)):
        t = 1 - (y / (H * 0.18))
        eased = t ** 0.8
        alpha = int(eased * 170)
        gdraw.line([(0, y), (W, y)], fill=(0, 0, 0, alpha))

    base_rgba = base.convert("RGBA")
    composed = Image.alpha_composite(base_rgba, grad)
    draw = ImageDraw.Draw(composed)

    # Fonts — try common macOS/Linux paths, fall back to PIL default
    serif_bold = load_font([
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/System/Library/Fonts/Georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    ], 64)
    serif_reg = load_font([
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    ], 26)
    sans_bold = load_font([
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ], 20)
    sans_reg = load_font([
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ], 22)

    PADX = 60

    # Top-left eyebrow: coral bar + kicker line (with soft shadow)
    bar_y = 44
    draw.rectangle([(PADX, bar_y), (PADX + 64, bar_y + 5)], fill=CORAL)
    kicker = "LIVINGSTON, TX  ·  FAMILY-OWNED SINCE 2020"
    # Drop-shadow for legibility over dark cart bodies
    draw.text((PADX + 82, bar_y - 7), kicker, font=sans_bold, fill=(0, 0, 0, 180))
    draw.text((PADX + 80, bar_y - 8), kicker, font=sans_bold, fill=CREAM)

    # Big serif headline anchored to the bottom-left, tucked under
    # the sign so the composition frames it.
    headline_lines = [
        "The cart you want.",
        "Built by a neighbor you trust.",
    ]
    serif_bold = load_font([
        "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
        "/System/Library/Fonts/Georgia.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    ], 54)
    line_h = 66
    total_h = line_h * len(headline_lines)
    # Anchor the headline block so its BOTTOM sits ~150px above the CTA
    head_end_y = H - 150
    y = head_end_y - total_h
    # Soft shadow behind headline for depth
    for line in headline_lines:
        # Drop shadow
        draw.text((PADX + 2, y + 3), line, font=serif_bold, fill=(0, 0, 0, 130))
        draw.text((PADX, y), line, font=serif_bold, fill=CREAM)
        y += line_h

    # Subhead — service lines, in coral so it pops off the teal wash
    sub = "Sales  ·  Service  ·  Custom Builds  ·  Rentals"
    draw.text((PADX, y + 10), sub, font=serif_reg, fill=CORAL)

    # Coral CTA pill in the bottom-left, holding URL + phone
    cta = "polkcountygolfcarts.com   ·   936-223-1182"
    tx, ty, tw, th = draw.textbbox((0, 0), cta, font=sans_bold)
    pill_padx, pill_pady = 22, 12
    pill_w = (tw - tx) + pill_padx * 2
    pill_h = (th - ty) + pill_pady * 2
    pill_x1 = PADX
    pill_y1 = H - 74
    pill_x2 = pill_x1 + pill_w
    pill_y2 = pill_y1 + pill_h
    draw_pill(draw, (pill_x1, pill_y1, pill_x2, pill_y2), radius=pill_h // 2,
              fill=CORAL)
    draw.text((pill_x1 + pill_padx, pill_y1 + pill_pady - 2),
              cta, font=sans_bold, fill=(255, 255, 255))

    # Save as PNG (kept the .png extension so social scrapers don't
    # need to re-fetch). Optimize for a smaller wire payload.
    out = composed.convert("RGB")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
