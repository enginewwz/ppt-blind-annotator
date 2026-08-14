"""生成 4 组演示 pptx（methodA~D，各 2 个 Deck：slide_001 两页、slide_002 一页）。

每组用不同主题色，便于查看 4 列并排的空间排布。覆盖写，安全（ingest 会按源变化增量重渲）。
用法：
    python scripts/make_demo.py
"""
from __future__ import annotations

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
DECKS = {"slide_001": 2, "slide_002": 1}
WHITE = RGBColor(0xFF, 0xFF, 0xFF)


def add_slide(prs: Presentation, method: str, deck_name: str, page_idx: int, color) -> None:
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
        f"页面：{page_idx + 1}/{DECKS[deck_name]}",
        "（演示占位内容，仅用于查看 4 列并排布局）",
    ]
    for i, line in enumerate(lines):
        para = bf.paragraphs[0] if i == 0 else bf.add_paragraph()
        run = para.add_run()
        run.text = line
        run.font.size = Pt(18)
        run.font.color.rgb = WHITE


def main() -> int:
    demo = paths.DATA_DIR / "demo"
    for method, color in METHODS.items():
        mdir = demo / method
        mdir.mkdir(parents=True, exist_ok=True)
        for deck_name, pages in DECKS.items():
            prs = Presentation()
            prs.slide_width = Inches(10)
            prs.slide_height = Inches(7.5)
            for pi in range(pages):
                add_slide(prs, method, deck_name, pi, color)
            prs.save(mdir / f"{deck_name}.pptx")
            print(f"[make_demo] {method}/{deck_name}.pptx ({pages} 页)")
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
    print("[make_demo] 完成：4 组样例已生成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
