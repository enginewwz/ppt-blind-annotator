"""生成演示 pptx（默认 2 个 Deck × 4 组 methodA~D；`--count N` 生成 N 个 Deck 用于规模压测）。

每组用不同主题色，便于查看 4 列并排的空间排布。覆盖写，安全（ingest 会按源变化增量重渲）。
用法：
    python scripts/make_demo.py              # 2 个 Deck（slide_001 两页、slide_002 一页）
    python scripts/make_demo.py --count 200  # 200 个 Deck（slide_001..slide_200）压测
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pptx import Presentation  # noqa: E402
from pptx.dml.color import RGBColor  # noqa: E402
from pptx.enum.shapes import MSO_SHAPE  # noqa: E402
from pptx.enum.text import PP_ALIGN  # noqa: E402
from pptx.util import Inches, Pt  # noqa: E402

from scripts import paths  # noqa: E402

METHODS = {
    "methodA": RGBColor(0x1F, 0x6F, 0xEB),  # 蓝
    "methodB": RGBColor(0x1F, 0xA3, 0x4D),  # 绿
    "methodC": RGBColor(0xE8, 0x7B, 0x24),  # 橙
    "methodD": RGBColor(0x8B, 0x5C, 0xF6),  # 紫
}
WHITE = RGBColor(0xFF, 0xFF, 0xFF)


def deck_pages(i: int) -> int:
    """第 i 个 Deck 的页数：奇数 2 页、偶数 1 页（与默认两个样例一致，交替可控渲染量）。"""
    return 5 if i % 2 == 1 else 4


def add_slide(prs: Presentation, method: str, deck_name: str,
              page_idx: int, page_count: int, color) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid()
    bg.fill.fore_color.rgb = color
    bg.line.fill.background()

    tb = slide.shapes.add_textbox(Inches(0.6), Inches(0.5), Inches(8.8), Inches(1.2))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    r = p.add_run()
    r.text = f"{method} · {deck_name}"
    r.font.size = Pt(40)
    r.font.bold = True
    r.font.color.rgb = WHITE

    pg = slide.shapes.add_textbox(Inches(0.6), Inches(1.9), Inches(4), Inches(0.8))
    pr = pg.text_frame.paragraphs[0]
    rr = pr.add_run()
    rr.text = f"第 {page_idx + 1} 页"
    rr.font.size = Pt(24)
    rr.font.color.rgb = WHITE

    body = slide.shapes.add_textbox(Inches(0.6), Inches(3.1), Inches(8.8), Inches(3.0))
    bf = body.text_frame
    bf.word_wrap = True
    lines = [
        f"方法：{method}",
        f"Deck：{deck_name}",
        f"页面：{page_idx + 1}/{page_count}",
        "（演示占位内容，仅用于查看 4 列并排布局）",
    ]
    for i, line in enumerate(lines):
        para = bf.paragraphs[0] if i == 0 else bf.add_paragraph()
        run = para.add_run()
        run.text = line
        run.font.size = Pt(18)
        run.font.color.rgb = WHITE


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成演示 pptx（4 组 methodA~D × N 个 Deck）")
    parser.add_argument("--count", type=int, default=2,
                        help="生成的 Deck 数量（默认 2；规模压测可用 200/500）")
    args = parser.parse_args(argv)
    count = max(1, args.count)

    demo = paths.DATA_DIR / "demo"
    for method, color in METHODS.items():
        mdir = demo / method
        mdir.mkdir(parents=True, exist_ok=True)
        for i in range(1, count + 1):
            deck_name = f"slide_{i:03d}"
            pages = deck_pages(i)
            prs = Presentation()
            prs.slide_width = Inches(10)
            prs.slide_height = Inches(7.5)
            for pi in range(pages):
                add_slide(prs, method, deck_name, pi, pages, color)
            prs.save(mdir / f"{deck_name}.pptx")
    if count <= 20:
        for method in METHODS:
            for i in range(1, count + 1):
                print(f"[make_demo] {method}/slide_{i:03d}.pptx ({deck_pages(i)} 页)")
    else:
        print(f"[make_demo] 已生成 {count} 个 Deck × {len(METHODS)} 组 = {count * len(METHODS)} 个 pptx")
        print(f"[make_demo] 注意：ingest 渲染相应较久，且 rendered/ 图片会占磁盘（可用数据页缓存上限控制）。")
    # 生成自描述的 data/config.json（data/ 视为「外部目录」：data_dir 指向自身）
    from scripts.atomic import atomic_write_json  # noqa: E402

    cfg = {
        "data_dir": str(paths.DATA_DIR),
        "datasets": [
            {"name": m, "path": f"demo/{m}", "sort_order": i}
            for i, m in enumerate(METHODS)
        ],
        "prefs": {"shuffle": False, "sync_page": True},
    }
    atomic_write_json(paths.DATA_DIR / "config.json", cfg)
    print(f"[make_demo] config.json -> {paths.DATA_DIR / 'config.json'}（data_dir={cfg['data_dir']}）")
    print(f"[make_demo] 完成：{len(METHODS)} 组 × {count} 个 Deck 已生成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
