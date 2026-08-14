"""M0 骨架：读配置 → 扫描输入目录 → 按文件名归组 Deck → 生成 manifest/status（全部 pending）。

渲染管线（soffice/PyMuPDF/Pillow）在 M1 加入；本脚本只负责「分组 + 建清单」。
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import shutil
import sys
from pathlib import Path
from typing import Any

# 允许 `python scripts/ingest.py` 直接运行（也支持 `python -m scripts.ingest`）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402
from scripts.atomic import atomic_write_json, now_iso  # noqa: E402
from scripts.constants import (  # noqa: E402
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_READY,
    STATUS_RENDERING,
)
from scripts.render import render_version, src_key  # noqa: E402

PPTX_EXTS = {".pptx", ".ppt"}


def load_config(config_path: Path) -> dict:
    """读取并校验 config.json。"""
    if not config_path.is_file():
        raise FileNotFoundError(f"配置文件不存在: {config_path}")
    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if "datasets" not in cfg or not isinstance(cfg["datasets"], list):
        raise ValueError("config.json 必须包含 datasets 列表")
    return cfg


def scan_pptx(dir_path: Path) -> list[Path]:
    """返回目录下所有 pptx/ppt 文件（按文件名排序）。目录不存在返回空。"""
    if not dir_path.is_dir():
        return []
    return sorted(
        (p for p in dir_path.iterdir()
         if p.is_file() and p.suffix.lower() in PPTX_EXTS),
        key=lambda p: p.name,
    )


def _resolve_ds_path(config_path: Path, raw: str, data_dir: Path | None = None) -> Path:
    """数据集路径：绝对路径直接用；相对路径以数据根为准（data_dir 优先，否则以
    配置文件所在目录），使 config 里的相对路径在「重定向到外部目录」时也能解析。"""
    p = Path(raw)
    if p.is_absolute():
        return p
    base = data_dir if data_dir is not None else config_path.parent
    return base / p


def group_decks(datasets: list[dict], config_path: Path, data_dir: Path | None = None) -> list[dict]:
    """按文件名（去扩展名）把跨数据集的 ppt 归组为 Deck。

    返回: [{"name": ..., "versions": [{"dataset_name", "file_path"}]}]
    """
    decks: dict[str, dict[str, Any]] = {}
    for ds in datasets:
        ds_name = str(ds["name"])
        ds_path = _resolve_ds_path(config_path, str(ds["path"]), data_dir)
        for f in scan_pptx(ds_path):
            stem = f.stem
            deck = decks.setdefault(stem, {"name": stem, "versions": []})
            deck["versions"].append({
                "dataset_name": ds_name,
                "file_path": str(f),
            })
    return list(decks.values())


def build_manifest(cfg: dict, config_path: Path, data_dir: Path | None = None) -> dict:
    """构建 manifest：数据集分配 id；Deck/版本初始为 pending。"""
    if data_dir is None:
        data_dir = _dirs_from_config(config_path, cfg)[0]
    datasets = cfg["datasets"]
    datasets_out = [
        {"id": i + 1, "name": str(ds["name"]), "sort_order": int(ds.get("sort_order", i))}
        for i, ds in enumerate(datasets)
    ]
    ds_id_by_name = {d["name"]: d["id"] for d in datasets_out}

    decks_out: list[dict[str, Any]] = []
    for deck in group_decks(datasets, config_path, data_dir):
        versions = [
            {
                "dataset_id": ds_id_by_name[v["dataset_name"]],
                "file_path": v["file_path"],
                "status": STATUS_PENDING,
                "page_count": 0,
                "pages": [],
            }
            for v in deck["versions"]
        ]
        decks_out.append({
            "id": len(decks_out) + 1,
            "name": deck["name"],
            "page_count": 0,
            "status": STATUS_PENDING,
            "versions": versions,
        })

    return {
        "version": 1,
        "datasets": datasets_out,
        "decks": decks_out,
    }


def build_status(manifest: dict) -> dict:
    """构建轻量状态文件（前端动态轮询用）。"""
    decks = manifest["decks"]
    return {
        "version": manifest["version"],
        "updated_at": now_iso(),
        "total": len(decks),
        "ready": 0,
        "rendering": 0,
        "failed": 0,
        # M1 起 ingest 以 --watch 后台运行时置 True
        "active": False,
    }


def _dirs_from_config(config_path: Path, cfg: dict) -> tuple[Path, Path, Path]:
    """数据根目录：config 里的 data_dir 可把输出重定向到外部 data 目录（前端把外部 config
    复制到工作区 config 时自动带上，避免写死每条路径）；否则以 config 所在目录为根。
    meta/、rendered/ 都写到该根下，前端经其句柄直读。"""
    raw = cfg.get("data_dir")
    if raw:
        data_dir = Path(str(raw))
        if not data_dir.is_absolute():
            data_dir = config_path.parent / data_dir
    else:
        data_dir = config_path.parent
    return data_dir, data_dir / "meta", data_dir / "rendered"


def run(config_path: Path) -> dict:
    """M0：扫描 + 归组 + 生成 pending 清单（不渲染）。保留用于快速预览/测试。"""
    cfg = load_config(config_path)
    manifest = build_manifest(cfg, config_path)
    status = build_status(manifest)
    _, meta_dir, _ = _dirs_from_config(config_path, cfg)
    meta_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(meta_dir / "manifest.json", manifest)
    atomic_write_json(meta_dir / "status.json", status)
    return {"manifest": manifest, "status": status, "config": cfg}


# ---------------- M1：渲染管线 ----------------


def load_existing_manifest(manifest_path: Path) -> dict | None:
    """读取现有 manifest（无则返回 None）。"""
    if manifest_path.is_file():
        with open(manifest_path, encoding="utf-8") as f:
            return json.load(f)
    return None


def build_or_merge_manifest(cfg: dict, config_path: Path, manifest_path: Path,
                            data_dir: Path | None = None) -> dict:
    """用当前扫描结果重建清单，并把旧清单中「源文件未变且已就绪」的版本带过来（增量/断点续跑）。"""
    manifest = build_manifest(cfg, config_path, data_dir)
    old = load_existing_manifest(manifest_path)
    if old and isinstance(old.get("version"), int):
        # 保持 version 单调递增（前端据此判断是否变化）
        manifest["version"] = old["version"]

    if not old or not old.get("decks"):
        for deck in manifest["decks"]:
            for v in deck["versions"]:
                v["src_key"] = src_key(Path(v["file_path"]))
        finalize_deck_statuses(manifest)
        return manifest

    old_ds = {d["id"]: d["name"] for d in old.get("datasets", [])}
    new_ds = {d["id"]: d["name"] for d in manifest["datasets"]}
    old_by_deck: dict[str, dict[tuple, dict]] = {}
    for od in old.get("decks", []):
        old_by_deck[od["name"]] = {
            (od["name"], old_ds.get(ov.get("dataset_id"))): ov
            for ov in od.get("versions", [])
        }

    for deck in manifest["decks"]:
        for v in deck["versions"]:
            ds_name = new_ds.get(v["dataset_id"])
            oldv = old_by_deck.get(deck["name"], {}).get((deck["name"], ds_name))
            key = src_key(Path(v["file_path"]))
            if oldv and oldv.get("src_key") == key and oldv.get("status") == STATUS_READY:
                v["status"] = STATUS_READY
                v["page_count"] = oldv.get("page_count", 0)
                v["pages"] = oldv.get("pages", [])
                v["src_key"] = oldv.get("src_key")
            else:
                v["status"] = STATUS_PENDING
                v["src_key"] = key
                v["page_count"] = 0
                v["pages"] = []
    finalize_deck_statuses(manifest)
    return manifest


def finalize_deck_statuses(manifest: dict) -> None:
    """按版本状态汇总 Deck 状态与 page_count（就地修改）。"""
    for deck in manifest["decks"]:
        st = [v.get("status", STATUS_PENDING) for v in deck["versions"]]
        if all(s == STATUS_READY for s in st):
            deck["status"] = STATUS_READY
        elif any(s == STATUS_RENDERING for s in st):
            deck["status"] = STATUS_RENDERING
        elif any(s == STATUS_FAILED for s in st):
            deck["status"] = STATUS_FAILED
        else:
            deck["status"] = STATUS_PENDING
        deck["page_count"] = max(
            (v.get("page_count", 0) for v in deck["versions"]), default=0
        )


def build_status_from_manifest(manifest: dict, active: bool) -> dict:
    decks = manifest["decks"]
    return {
        "version": manifest.get("version", 1),
        "updated_at": now_iso(),
        "total": len(decks),
        "ready": sum(1 for d in decks if d["status"] == STATUS_READY),
        "rendering": sum(1 for d in decks if d["status"] == STATUS_RENDERING),
        "failed": sum(1 for d in decks if d["status"] == STATUS_FAILED),
        "active": active,
    }


def warn_missing_datasets(cfg: dict, config_path: Path, data_dir: Path | None = None) -> None:
    """数据集路径不存在时打印警告，避免静默清空清单。"""
    if data_dir is None:
        data_dir = _dirs_from_config(config_path, cfg)[0]
    for ds in cfg.get("datasets", []):
        if not _resolve_ds_path(config_path, str(ds["path"]), data_dir).is_dir():
            print(f"[ingest] 警告: 数据集 '{ds['name']}' 路径不存在: {ds['path']}")


def _persist(manifest: dict, active: bool, meta_dir: Path) -> dict:
    """原子写 manifest + status（version 自增），返回 status。"""
    meta_dir.mkdir(parents=True, exist_ok=True)
    manifest["version"] = int(manifest.get("version", 0)) + 1
    atomic_write_json(meta_dir / "manifest.json", manifest)
    status = build_status_from_manifest(manifest, active)
    atomic_write_json(meta_dir / "status.json", status)
    return status


def _render_job(job: tuple) -> tuple:
    """多进程 worker 入口：解包 (deck_idx, version_idx, args) 并渲染。"""
    di, vi, args = job
    return di, vi, render_version(args)


def _cleanup_orphan_renders(manifest: dict, rendered_dir: Path) -> None:
    """删除清单中已不再引用的渲染产物（数据集被移除、Deck 版本减少时），
    避免 config 变更后磁盘残留碎片文件。"""
    ds_name = {d["id"]: d["name"] for d in manifest["datasets"]}
    referenced = {
        rendered_dir / ds_name[v["dataset_id"]] / deck["name"]
        for deck in manifest["decks"]
        for v in deck["versions"]
    }
    if not rendered_dir.is_dir():
        return
    for ds_dir in sorted(rendered_dir.iterdir()):
        if not ds_dir.is_dir():
            continue
        for deck_dir in sorted(ds_dir.iterdir()):
            if deck_dir.is_dir() and deck_dir not in referenced:
                shutil.rmtree(deck_dir, ignore_errors=True)
                try:
                    rel = deck_dir.relative_to(paths.PROJECT_ROOT)
                except ValueError:
                    rel = deck_dir
                print(f"[ingest] 清理孤儿渲染产物: {rel}")
        # 数据集目录被清空则一并移除
        if not any(ds_dir.iterdir()):
            try:
                ds_dir.rmdir()
            except OSError:
                pass


def run_render(
    cfg: dict,
    config_path: Path,
    jobs: int,
    dpi: int,
    thumb_width: int,
    soffice: str,
    active: bool,
) -> dict:
    """执行一次渲染 pass：合并旧状态 → 标记渲染中 → 渲染 → 逐结果更新 manifest/status。

    输出目录跟随 config 所在目录（meta/、rendered/ 都写到所选 data 目录内）。"""
    data_dir, meta_dir, rendered_dir = _dirs_from_config(config_path, cfg)
    manifest_path = meta_dir / "manifest.json"
    manifest = build_or_merge_manifest(cfg, config_path, manifest_path, data_dir)
    finalize_deck_statuses(manifest)
    # config 变更后清理孤儿产物（在标记渲染中之前，不会误删本轮要渲染的目录）
    _cleanup_orphan_renders(manifest, rendered_dir)

    ds_name = {d["id"]: d["name"] for d in manifest["datasets"]}
    pending: list[tuple] = []
    for di, deck in enumerate(manifest["decks"]):
        for vi, v in enumerate(deck["versions"]):
            if v.get("status") == STATUS_READY:
                continue
            out_dir = rendered_dir / ds_name[v["dataset_id"]] / deck["name"]
            pending.append((di, vi, {
                "file_path": v["file_path"],
                "out_dir": str(out_dir),
                "dpi": dpi,
                "thumb_width": thumb_width,
                "soffice": soffice,
            }))
            v["status"] = STATUS_RENDERING

    # 无变化（无待渲染且 manifest 与磁盘一致）→ 不写盘，保持 version 稳定。
    # 前端固定 1s 轮询 status：version 只在真有变化时 +1，避免空转反复重读大 manifest。
    old = load_existing_manifest(manifest_path)
    if not pending and old is not None and old == manifest:
        return {"manifest": manifest, "status": build_status_from_manifest(manifest, active)}

    # 先落一次「渲染中」，前端可立即看到
    finalize_deck_statuses(manifest)
    _persist(manifest, active, meta_dir)

    if pending:
        n = min(jobs, len(pending))
        if n <= 1:
            results = [_render_job(job) for job in pending]
        else:
            with mp.Pool(processes=n) as pool:
                results = list(pool.imap_unordered(_render_job, pending))

        root = data_dir   # 图片路径相对「所选 data 目录」，前端经 FS 句柄读取，任意路径可部署
        for di, vi, res in results:
            v = manifest["decks"][di]["versions"][vi]
            if res["ok"]:
                v["status"] = STATUS_READY
                v["page_count"] = res["page_count"]
                pages = []
                for p in res["pages"]:
                    src = Path(p["src"])
                    thumb = Path(p["thumb"])
                    pages.append({
                        "src": str(src.relative_to(root)) if src.is_relative_to(root) else p["src"],
                        "thumb": str(thumb.relative_to(root)) if thumb.is_relative_to(root) else p["thumb"],
                        "w": p["w"],
                        "h": p["h"],
                    })
                v["pages"] = pages
                v.pop("error", None)
            else:
                v["status"] = STATUS_FAILED
                v["error"] = res.get("error", "unknown")
                v["pages"] = []
            finalize_deck_statuses(manifest)
            _persist(manifest, active, meta_dir)

    finalize_deck_statuses(manifest)
    status = _persist(manifest, active, meta_dir)
    return {"manifest": manifest, "status": status}


def _config_fingerprint(config_path: Path) -> tuple:
    """config.json 指纹 (mtime_ns, size)：未变化则不重读，缩小读写冲突窗口。"""
    try:
        st = config_path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


def _load_config_retry(config_path: Path, attempts: int = 5, delay: float = 0.2) -> dict:
    """读取 config.json；容忍浏览器写入期间的瞬态撕裂读（读到写一半的 JSON）。"""
    import time

    last_err: Exception | None = None
    for _ in range(attempts):
        try:
            return load_config(config_path)
        except (json.JSONDecodeError, OSError, ValueError) as e:
            last_err = e
            time.sleep(delay)
    raise RuntimeError(f"config.json 读取失败（重试 {attempts} 次）: {last_err}")


def _watch_loop(args: argparse.Namespace) -> int:
    import time

    print(f"[ingest] watch 模式启动（间隔 {args.interval}s，Ctrl+C 停止）")
    cfg_path = Path(args.config)
    # 配置尚不存在（launch.py --config 可指向尚未创建的 data 目录/config）：等待其出现
    if not cfg_path.is_file():
        print(f"[ingest] 等待配置创建: {cfg_path}")
        print("[ingest] 页面「数据」页勾选备选文件夹并「提交修改」后会自动生成并开始渲染")
    while not cfg_path.is_file():
        time.sleep(args.interval)
    cfg = load_config(cfg_path)
    warn_missing_datasets(cfg, cfg_path)
    last_fp = _config_fingerprint(cfg_path)
    while True:
        fp = _config_fingerprint(cfg_path)
        if fp != last_fp:
            try:
                cfg = _load_config_retry(cfg_path)
                last_fp = fp
                warn_missing_datasets(cfg, cfg_path)
            except Exception as e:  # noqa: BLE001
                # 配置正在被写入：本轮跳过并保留上次成功配置；不更新 last_fp，
                # 下一轮会重试读取——绝不用半个配置跑渲染，也就不产生半成品产物。
                print(f"[ingest] config.json 变化但读取失败，跳过本轮: {e}")
        run_render(cfg, cfg_path, args.jobs, args.dpi, args.thumb_width, args.soffice, active=True)
        time.sleep(args.interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PPT 盲测对照：扫描/归组/渲染/建清单")
    parser.add_argument("--config", default=str(paths.WATCH_CONFIG_PATH),
                        help="配置文件路径（默认：工作区根目录 watched/config.json）")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="渲染并行度")
    parser.add_argument("--dpi", type=int, default=150, help="渲染 DPI（默认 150）")
    parser.add_argument("--thumb-width", type=int, default=360, help="缩略图宽度（默认 360）")
    parser.add_argument("--soffice", default="soffice", help="soffice 可执行文件路径")
    parser.add_argument("--interval", type=float, default=5.0, help="watch 模式扫描间隔（秒）")
    parser.add_argument("--watch", action="store_true", help="持续运行（增量，检测新/改文件）")
    args = parser.parse_args(argv)

    if args.watch:
        return _watch_loop(args)

    cfg_path = Path(args.config)
    cfg = load_config(cfg_path)
    warn_missing_datasets(cfg, cfg_path)
    result = run_render(cfg, cfg_path, args.jobs, args.dpi, args.thumb_width, args.soffice, active=False)
    m, s = result["manifest"], result["status"]
    print(f"[ingest] 数据集: {len(m['datasets'])} 个")
    print(f"[ingest] Deck: 总 {s['total']} / 就绪 {s['ready']} / 渲染中 {s['rendering']} / 失败 {s['failed']}")
    _, meta_dir, _ = _dirs_from_config(cfg_path, cfg)
    print(f"[ingest] manifest -> {meta_dir / 'manifest.json'}")
    print(f"[ingest] status   -> {meta_dir / 'status.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
