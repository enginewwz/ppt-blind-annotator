"""M3 报告生成：读 manifest + annotations → 聚合每数据集 / 每 Deck 统计 →
输出 reports/report.{json,csv,html}（HTML 内联 CSS 柱状图 + 回链 `index.html#/deck/<id>`）。

用法：
    python scripts/report.py [--config watched/config.json] [--out reports/] [--fmt all|csv|json|html]

- 数据来源：config 的 data_dir（无则 config 所在目录）下的 meta/manifest.json + annotations.json。
- 聚合内容：每数据集的分数分布 / 均值 / 中位数 / 方差 / 标准差、best / worst 命中数；
  每 Deck 一条明细（各数据源分数 + 排名标记 + 状态）。
- 前端 report.js 在浏览器内做同样的实时聚合；本脚本产出可供离线分析的 CSV / JSON / HTML。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean, median, pstdev, pvariance
from typing import Any

# 允许 `python scripts/report.py` 直接运行（也支持 `python -m scripts.report`）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402
from scripts.atomic import atomic_write_text, now_iso  # noqa: E402
from scripts.ingest import _dirs_from_config  # noqa: E402

SCORE_MIN, SCORE_MAX = 1, 5


# ---------------- 统计工具 ----------------


def _numbers(scores: Any) -> list[float]:
    """过滤出 [1..5] 范围内的数值分数（容忍字符串 / 越界值）。"""
    out: list[float] = []
    for v in scores or []:
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        if SCORE_MIN <= n <= SCORE_MAX:
            out.append(n)
    return out


def score_stats(scores: Any) -> dict:
    """一组分数的统计：count / mean / median / variance / stddev / distribution{1..5}。

    空样本时 count=0、其余为 None（distribution 恒为全 0）。"""
    xs = _numbers(scores)
    dist = {str(i): 0 for i in range(SCORE_MIN, SCORE_MAX + 1)}
    for x in xs:
        dist[str(int(x))] += 1
    if not xs:
        return {"count": 0, "mean": None, "median": None,
                "variance": None, "stddev": None, "distribution": dist}
    return {
        "count": len(xs),
        "mean": round(mean(xs), 4),
        "median": round(median(xs), 4),
        "variance": round(pvariance(xs), 4),
        "stddev": round(pstdev(xs), 4),
        "distribution": dist,
    }


# ---------------- 聚合 ----------------


def _rank_of(rank: str) -> str:
    """由 best/worst 命中算单个版本的排名标记：best / worst / both / ""。"""
    if rank == "both":
        return "both"
    if rank == "best":
        return "best"
    if rank == "worst":
        return "worst"
    return ""


def aggregate(manifest: dict, annotations: dict | None) -> dict:
    """聚合 manifest + annotations 为报告结构。

    manifest:  {datasets:[{id,name,...}], decks:[{id,name,versions:[{dataset_id,...}]}]}
    annotations: {deck_id_str: {status, best, worst, scores:{dataset_id:1..5}, ...}} 或 None
    """
    datasets = manifest.get("datasets", []) or []
    decks = manifest.get("decks", []) or []
    ann = annotations or {}
    ds_by_id = {d.get("id"): d.get("name", "") for d in datasets}

    ds_agg = {
        d.get("id"): {"id": d.get("id"), "name": d.get("name", ""),
                      "decks": 0, "annotated": 0, "scores": [], "best": 0, "worst": 0}
        for d in datasets
    }
    deck_rows: list[dict] = []
    totals = {"decks": len(decks), "annotated": 0, "submitted": 0, "draft": 0}

    for deck in decks:
        did = deck.get("id")
        a = ann.get(str(did)) if ann.get(str(did)) is not None else ann.get(did)
        versions = deck.get("versions", []) or []

        # 数据源「包含该 Deck」计数（不随是否标注变化）
        for v in versions:
            agg = ds_agg.get(v.get("dataset_id"))
            if agg is not None:
                agg["decks"] += 1

        row = {
            "id": did,
            "name": deck.get("name", ""),
            "status": (a or {}).get("status", "") if a else "",
            "annotated": bool(a),
            "updated_at": (a or {}).get("updated_at", "") if a else "",
            "submitted_at": (a or {}).get("submitted_at", "") if a else "",
            "best": a.get("best") if a else None,
            "worst": a.get("worst") if a else None,
            "versions": [],
        }
        if a:
            totals["annotated"] += 1
            if a.get("status") == "submitted":
                totals["submitted"] += 1
            elif a.get("status") == "draft":
                totals["draft"] += 1

        scores = (a.get("scores") or {}) if a else {}
        best = a.get("best") if a else None
        worst = a.get("worst") if a else None
        for v in versions:
            dsid = v.get("dataset_id")
            if dsid not in ds_by_id:
                continue
            sc = scores.get(str(dsid))
            if sc is None:
                sc = scores.get(dsid)  # 兼容整数键
            if a:
                agg = ds_agg[dsid]
                agg["annotated"] += 1
                if sc is not None:
                    try:
                        agg["scores"].append(float(sc))
                    except (TypeError, ValueError):
                        pass
                if dsid == best:
                    agg["best"] += 1
                if dsid == worst:
                    agg["worst"] += 1
            rank = "both" if (best is not None and dsid == best and worst is not None and dsid == worst) \
                else ("best" if (best is not None and dsid == best)
                      else ("worst" if (worst is not None and dsid == worst) else ""))
            row["versions"].append({
                "dataset_id": dsid,
                "dataset": ds_by_id[dsid],
                "score": sc,
                "rank": _rank_of(rank),
            })
        deck_rows.append(row)

    datasets_out = [
        {
            "id": d.get("id"),
            "name": d.get("name", ""),
            "decks": ds_agg[d.get("id")]["decks"],
            "annotated": ds_agg[d.get("id")]["annotated"],
            "score": score_stats(ds_agg[d.get("id")]["scores"]),
            "best": ds_agg[d.get("id")]["best"],
            "worst": ds_agg[d.get("id")]["worst"],
        }
        for d in datasets
    ]

    return {
        "generated_at": now_iso(),
        "source": {
            "manifest_version": manifest.get("version"),
            "datasets": [d.get("name", "") for d in datasets],
        },
        "totals": totals,
        "datasets": datasets_out,
        "decks": deck_rows,
    }


# ---------------- 输出格式 ----------------


def _csv_field(value: Any) -> str:
    """CSV 字段转义（逗号 / 引号 / 换行）。"""
    s = "" if value is None else str(value)
    if any(c in s for c in (",", '"', "\n", "\r")):
        s = '"' + s.replace('"', '""') + '"'
    return s


def format_csv(report: dict) -> str:
    """逐 Deck × 数据源一行：deck_id, deck_name, dataset, rank_best, rank_worst,
    score, status, updated_at（含未标注 Deck，便于离线分析）。"""
    lines = ["deck_id,deck_name,dataset,rank_best,rank_worst,score,status,updated_at"]
    for deck in report["decks"]:
        for v in deck["versions"]:
            rank = v.get("rank", "")
            lines.append(",".join([
                str(deck["id"]),
                _csv_field(deck["name"]),
                _csv_field(v["dataset"]),
                "1" if rank in ("best", "both") else "",
                "1" if rank in ("worst", "both") else "",
                "" if v["score"] is None else str(v["score"]),
                _csv_field(deck["status"]),
                _csv_field(deck["updated_at"]),
            ]))
    return "\n".join(lines) + "\n"


def format_json(report: dict) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2) + "\n"


# HTML 报告的内联 CSS（无 CDN、可离线打开）。独立字符串，避免与 f-string 花括号冲突。
_HTML_CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  margin: 0; padding: 24px; color: #1f2328; background: #fff; line-height: 1.5;
}
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 10px; border-bottom: 1px solid #e6e9ee; padding-bottom: 6px; }
.meta { color: #8a8f98; font-size: 12px; margin: 0 0 18px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 16px 0; }
.card { background: #f1f4f8; border: 1px solid #e6e9ee; border-radius: 8px; padding: 12px 14px; }
.card .val { font-size: 22px; font-weight: 700; }
.card .lbl { font-size: 11px; color: #8a8f98; margin-top: 2px; }
.card.ok .val { color: #1a7f37; }
.card.warn .val { color: #9a6700; }
table { border-collapse: collapse; width: 100%; min-width: max-content; margin-top: 8px; }
th, td { padding: 6px 12px; text-align: center; border-bottom: 1px solid #e6e9ee; white-space: nowrap; font-size: 13px; }
thead th { position: sticky; top: 0; background: #f1f4f8; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
tbody th { background: #f1f4f8; font-weight: 600; }
.wrap { background: #f1f4f8; border: 1px solid #e6e9ee; border-radius: 8px; overflow: auto; }
.ok { color: #1a7f37; } .warn { color: #9a6700; } .err { color: #cf222e; } .muted { color: #8a8f98; }
a { color: #007acc; text-decoration: none; } a:hover { text-decoration: underline; }
.rank-best { color: #1a7f37; font-weight: 600; }
.rank-worst { color: #cf222e; font-weight: 600; }
.bars { display: inline-flex; align-items: flex-end; gap: 4px; height: 44px; }
.bar { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; width: 24px; height: 100%; }
.bar .track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.bar .fill { width: 100%; background: #007acc; border-radius: 2px 2px 0 0; min-height: 2px; }
.bar .n { font-size: 10px; line-height: 1; }
.bar .s { font-size: 10px; color: #8a8f98; line-height: 1.2; }
footer { margin-top: 32px; color: #8a8f98; font-size: 11px; }
code { background: rgba(0,0,0,0.05); padding: 0 4px; border-radius: 4px; font-size: 12px; }
"""


def _bar_chart(dist: dict) -> str:
    """分数分布的内联 CSS 柱状图 HTML（1..5 各一柱，高度按最大值归一）。"""
    vals = [int(dist.get(str(i), 0) or 0) for i in range(SCORE_MIN, SCORE_MAX + 1)]
    maxv = max(vals) or 1
    bars = []
    for i, cnt in enumerate(vals, start=SCORE_MIN):
        h = round(cnt / maxv * 100)
        bars.append(
            f'<div class="bar" title="{i} 分：{cnt} 个">'
            f'<div class="track"><div class="fill" style="height:{h}%"></div></div>'
            f'<span class="n">{cnt}</span><span class="s">{i}</span></div>'
        )
    return '<div class="bars">' + "".join(bars) + "</div>"


def format_html(report: dict) -> str:
    """自包含 HTML：汇总卡 + 数据源汇总表（柱状图）+ 逐 Deck 明细表（回链）。"""
    t = report["totals"]
    pending = t["decks"] - t["annotated"]
    cards = "".join(
        f'<div class="card"><div class="val">{v}</div><div class="lbl">{l}</div></div>'
        for l, v in (("Deck 总数", t["decks"]), ("已标注", t["annotated"]),
                     ("已提交", t["submitted"]), ("草稿", t["draft"]),
                     ("待标注", pending))
    )

    ds_rows = []
    for d in report["datasets"]:
        st = d["score"]
        fmt = lambda n: "—" if n is None else str(n)
        ds_rows.append(
            "<tr>"
            f"<th>{d['name']}</th>"
            f"<td>{d['annotated']} / {d['decks']}</td>"
            f'<td class="ok">{d["best"]}</td>'
            f'<td class="err">{d["worst"]}</td>'
            f"<td>{fmt(st['mean'])}</td>"
            f"<td>{fmt(st['median'])}</td>"
            f"<td>{fmt(st['variance'])}</td>"
            f"<td>{fmt(st['stddev'])}</td>"
            f"<td>{_bar_chart(st['distribution'])}</td>"
            "</tr>"
        )

    deck_rows = []
    for deck in report["decks"]:
        if deck["annotated"]:
            status = ('<span class="ok">已提交</span>' if deck["status"] == "submitted"
                      else '<span class="warn">草稿</span>')
        else:
            status = '<span class="muted">未标注</span>'
        cells = []
        for v in deck["versions"]:
            s = ('<span class="muted">-</span>' if v["score"] is None
                 else str(v["score"]))
            if v["rank"] == "best":
                s = f'<span class="rank-best">{s} ★</span>'
            elif v["rank"] == "worst":
                s = f'<span class="rank-worst">{s} ✗</span>'
            cells.append(f"<td>{s}</td>")
        updated = deck["updated_at"][:19] if deck["updated_at"] else ""
        deck_rows.append(
            "<tr>"
            f'<th><a href="../app/static/index.html#/deck/{deck["id"]}">{deck["name"]}</a></th>'
            f"<td>{status}</td>"
            f"<td>{updated}</td>"
            + "".join(cells) +
            "</tr>"
        )

    ds_cols = "".join(f"<th>{d['name']}</th>" for d in report["datasets"])
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PPT 盲测标注报告</title>
<style>{_HTML_CSS}</style>
</head>
<body>
<h1>PPT 盲测标注报告</h1>
<p class="meta">生成时间：{report["generated_at"]} · manifest v{report["source"].get("manifest_version")} · 数据源：{", ".join(report["source"].get("datasets", [])) or "—"}</p>
<div class="cards">{cards}</div>

<h2>数据源汇总</h2>
<div class="wrap"><table>
<thead><tr><th>数据源</th><th>已标/总数</th><th>最佳</th><th>最差</th><th>均值</th><th>中位数</th><th>方差</th><th>标准差</th><th>分数分布</th></tr></thead>
<tbody>{''.join(ds_rows)}</tbody>
</table></div>

<h2>逐 Deck 明细</h2>
<div class="wrap"><table>
<thead><tr><th>Deck</th><th>状态</th><th>更新时间</th>{ds_cols}</tr></thead>
<tbody>{''.join(deck_rows)}</tbody>
</table></div>

<footer>由 <code>python scripts/report.py</code> 生成 · 点击 Deck 名可回链标注页（需在应用内打开）。</footer>
</body>
</html>
"""


# ---------------- 定位与 CLI ----------------


def _read_json(path: Path) -> Any | None:
    if not path.is_file():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _load_config_lenient(config_path: Path) -> dict:
    """读取 config：报告只需要 data_dir 定位输出，不强制 datasets 列表
    （launch 重置后的空 config / 仅含 data_dir 的外部 config 也能出报告）。"""
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def locate_paths(config_path: Path) -> tuple[Path, Path, Path, dict]:
    """由 config 解析数据根（data_dir 重定向），返回
    (data_dir, manifest_path, annotations_path, cfg)。"""
    cfg = _load_config_lenient(config_path)
    data_dir, meta_dir, _ = _dirs_from_config(config_path, cfg)
    return data_dir, meta_dir / "manifest.json", data_dir / "annotations.json", cfg


def generate(config_path: Path, out_dir: Path) -> dict:
    """读取 → 聚合 → 输出 report.{json,csv,html}，返回 report 结构（供 CLI 打印汇总）。"""
    data_dir, manifest_path, annotations_path, cfg = locate_paths(config_path)
    manifest = _read_json(manifest_path) or {"version": None, "datasets": [], "decks": []}
    annotations = _read_json(annotations_path) or {}
    report = aggregate(manifest, annotations)

    out_dir.mkdir(parents=True, exist_ok=True)
    for fmt, text in (("json", format_json(report)),
                      ("csv", format_csv(report)),
                      ("html", format_html(report))):
        target = out_dir / f"report.{fmt}"
        atomic_write_text(target, text)
        print(f"[report] {target}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PPT 盲测对照：聚合标注生成报告（JSON/CSV/HTML）")
    parser.add_argument("--config", default=str(paths.WATCH_CONFIG_PATH),
                        help="配置文件路径（默认：工作区根目录 watched/config.json）")
    parser.add_argument("--out", default=str(paths.REPORTS_DIR),
                        help="报告输出目录（默认：工作区 reports/）")
    parser.add_argument("--fmt", default="all", choices=["all", "csv", "json", "html"],
                        help="输出格式（默认 all = 三种全出）")
    args = parser.parse_args(argv)

    cfg_path = Path(args.config)
    out_dir = Path(args.out)

    if args.fmt == "all":
        report = generate(cfg_path, out_dir)
    else:
        data_dir, manifest_path, annotations_path, cfg = locate_paths(cfg_path)
        manifest = _read_json(manifest_path) or {"version": None, "datasets": [], "decks": []}
        annotations = _read_json(annotations_path) or {}
        report = aggregate(manifest, annotations)
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / f"report.{args.fmt}"
        text = {"json": format_json, "csv": format_csv, "html": format_html}[args.fmt](report)
        atomic_write_text(target, text)
        print(f"[report] {target}")

    t = report["totals"]
    print(f"[report] Deck 总 {t['decks']} / 已标注 {t['annotated']} "
          f"/ 已提交 {t['submitted']} / 草稿 {t['draft']}")
    for d in report["datasets"]:
        print(f"[report]    {d['name']}: 已标 {d['annotated']}/{d['decks']} "
              f"均值 {d['score']['mean'] if d['score']['mean'] is not None else '—'} "
              f"最佳 {d['best']} 最差 {d['worst']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
