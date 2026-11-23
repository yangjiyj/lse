#!/usr/bin/env python3
"""构建多模态越狱图片渲染用的中文字体子集（仅构建期使用，运行时不依赖 fonttools）。

来源：Debian 包 fonts-noto-cjk 提供的 NotoSansCJK-Regular.ttc，取集合内第 2 号字体
（Noto Sans CJK SC）。子集范围：GB2312 全部字符（含一、二级汉字 6763 个与全角符号）
+ 可打印 ASCII + 常用中文标点。许可证 SIL OFL-1.1，子集属于 OFL 意义下的 Modified Version，
随附 apps/api/assets/fonts/OFL-1.1.txt。

用法（fonttools 只在构建时需要，可装在临时 venv 中）：
  python3 -m venv /tmp/fonttools-venv && /tmp/fonttools-venv/bin/pip install fonttools==4.60.1
  /tmp/fonttools-venv/bin/python scripts/build-cjk-font-subset.py \
      [--source /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc]
"""
import argparse
import hashlib
import os
import sys

from fontTools import subset

DEFAULT_SOURCE = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_NUMBER = 2  # Noto Sans CJK SC
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO_ROOT, "apps", "api", "assets", "fonts")
OUT_NAME = "NotoSansSC-GB2312-Subset.otf"

# 常用中文标点（GB2312 已含大部分，此处兜底补齐常见全角/弯引号等）。
EXTRA_PUNCT = "，。、；：？！“”‘’（）《》〈〉【】『』「」—…·～￥％＋－＝×÷"


def gb2312_chars():
    chars = []
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            chars.append(ch)
    return chars


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE)
    args = parser.parse_args()

    text = set(gb2312_chars())
    text.update(chr(c) for c in range(0x20, 0x7F))
    text.update(EXTRA_PUNCT)
    unicodes = sorted(ord(c) for c in text)

    options = subset.Options()
    options.font_number = FONT_NUMBER
    options.name_IDs = ["*"]  # 保留版权、许可证等全部 name 记录（OFL 要求保留声明）
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.layout_features = ["kern", "liga", "locl", "vert"]
    options.hinting = False
    options.desubroutinize = False

    font = subset.load_font(args.source, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.join(OUT_DIR, OUT_NAME)
    subset.save_font(font, out_path, options)

    name = font["name"]
    print(f"source={args.source}")
    print(f"source_font_number={FONT_NUMBER}")
    print(f"source_family={name.getDebugName(1)}")
    print(f"source_version={name.getDebugName(5)}")
    print(f"source_sha256={sha256(args.source)}")
    print(f"subset={out_path}")
    print(f"subset_codepoints={len(unicodes)}")
    print(f"subset_bytes={os.path.getsize(out_path)}")
    print(f"subset_sha256={sha256(out_path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
