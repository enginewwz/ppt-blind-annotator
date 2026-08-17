"""读配置 → 扫描输入目录 → 按文件名归组 Deck → 生成 / 维护 manifest 与 status。

负责分组、建清单与增量渲染调度（--watch）；实际的图片渲染（soffice/PyMuPDF/Pillow）在 render.py。
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
        # ingest 以 --watch 后台运行时置 True
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
    """扫描 + 归组 + 生成 pending 清单（不渲染）。保留用于快速预览/测试。"""
    cfg = load_config(config_path)
    manifest = build_manifest(cfg, config_path)
    status = build_status(manifest)
    _, meta_dir, _ = _dirs_from_config(config_path, cfg)
    meta_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(meta_dir / "manifest.json", manifest)
    atomic_write_json(meta_dir / "status.json", status)
    return {"manifest": manifest, "status": status, "config": cfg}


# ---------------- 渲染管线 ----------------


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
            elif oldv and oldv.get("src_key") == key and oldv.get("evicted"):
                # 已被缓存清理（源未变）：保持 pending + evicted，不自动重渲
                v["status"] = STATUS_PENDING
                v["evicted"] = True
                v["src_key"] = oldv.get("src_key")
                v["page_count"] = 0
                v["pages"] = []
            else:
                v["status"] = STATUS_PENDING
                v["src_key"] = key
                v["page_count"] = 0
                v["pages"] = []
    finalize_deck_statuses(manifest)
    return manifest


def finalize_deck_statuses(manifest: dict) -> None:
    """按版本状态汇总 Deck 状态与 page_count，并重算 evicted 标记（就地修改）。"""
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
        vs = deck.get("versions", []) or []
        deck["evicted"] = bool(vs) and all(bool(v.get("evicted")) for v in vs)


def build_status_from_manifest(manifest: dict, active: bool,
                               batch: int | None = None,
                               batch_cli: bool = False) -> dict:
    decks = manifest["decks"]
    status = {
        "version": manifest.get("version", 1),
        "updated_at": now_iso(),
        "total": len(decks),
        "ready": sum(1 for d in decks if d["status"] == STATUS_READY),
        "rendering": sum(1 for d in decks if d["status"] == STATUS_RENDERING),
        "failed": sum(1 for d in decks if d["status"] == STATUS_FAILED),
        "active": active,
    }
    if batch is not None:
        # 每批数量（前端据此显示；batch_cli=True 表示由 CLI --batch 指定 → 前端下拉禁用）
        status["batch"] = int(batch)
        status["batch_cli"] = bool(batch_cli)
    return status


def warn_missing_datasets(cfg: dict, config_path: Path, data_dir: Path | None = None) -> None:
    """数据集路径不存在时打印警告，避免静默清空清单。"""
    if data_dir is None:
        data_dir = _dirs_from_config(config_path, cfg)[0]
    for ds in cfg.get("datasets", []):
        if not _resolve_ds_path(config_path, str(ds["path"]), data_dir).is_dir():
            print(f"[ingest] 警告: 数据集 '{ds['name']}' 路径不存在: {ds['path']}")


def _persist(manifest: dict, active: bool, meta_dir: Path,
             batch: int | None = None, batch_cli: bool = False) -> dict:
    """原子写 manifest + status（version 自增），返回 status。"""
    meta_dir.mkdir(parents=True, exist_ok=True)
    manifest["version"] = int(manifest.get("version", 0)) + 1
    atomic_write_json(meta_dir / "manifest.json", manifest)
    status = build_status_from_manifest(manifest, active, batch, batch_cli)
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


# ---------------- 插队渲染（优先级 + 分批） + 缓存总量管理 ----------------


PRIORITY_FOLLOW_DEFAULT = 3   # 插队时连同优先级 Deck 后多少个 Deck 一起提到最前
CACHE_PROTECT_FOLLOW = 4      # 缓存清理「保护窗」：当前查看 Deck 及其后 4 个 Deck 不清（并触发阻塞）


def parse_cache_limit(value) -> int | None:
    """解析缓存上限：'100M'/'300M'/'500M'/'1G'/'' → 字节数或 None（无限制）。

    'K'/'M'/'G' 后缀（大小写不敏感），纯数字视为字节；无法解析 / 非正数 → None（安全默认=无限制）。"""
    if value is None:
        return None
    s = str(value).strip().upper()
    if not s or s in ("0", "NONE", "UNLIMITED", "无限"):
        return None
    mult = 1
    if s.endswith("G"):
        mult = 1024 ** 3
        s = s[:-1]
    elif s.endswith("M"):
        mult = 1024 ** 2
        s = s[:-1]
    elif s.endswith("K"):
        mult = 1024
        s = s[:-1]
    try:
        n = float(s)
    except ValueError:
        return None
    if n <= 0:
        return None
    return int(n * mult)


def _dir_size(path: Path) -> int:
    """目录下所有文件字节数（递归）。"""
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def load_current_deck(data_dir: Path) -> int | None:
    """读取前端记录的当前查看 Deck（data_dir/current.json），供缓存清理保护；缺失 / 损坏返回 None。"""
    path = data_dir / "current.json"
    if not path.is_file():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return int(data.get("deck_id"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _cache_candidates(manifest: dict, rendered_dir: Path):
    """返回可清理（已就绪且有渲染产物）的 deck 候选，按「最久未写入」（mtime 升序）排列（旧的先清）。

    每项: (mtime, deck 下标, deck, 该 deck 各版本的渲染目录列表)。"""
    ds_name = {d["id"]: d["name"] for d in manifest["datasets"]}
    candidates: list[tuple[float, int, dict, list[Path]]] = []
    for di, deck in enumerate(manifest["decks"]):
        vs = deck.get("versions", []) or []
        if not vs or not all(v.get("status") == STATUS_READY for v in vs):
            continue
        dirs = [rendered_dir / ds_name.get(v["dataset_id"], "") / deck["name"]
                for v in vs]
        dirs = [d for d in dirs if d.is_dir()]
        if not dirs:
            continue
        try:
            mt = max((p.stat().st_mtime for d in dirs for p in d.rglob("*") if p.is_file()),
                     default=0.0)
        except OSError:
            mt = 0.0
        candidates.append((mt, di, deck, dirs))
    candidates.sort(key=lambda c: c[0])
    return candidates


def _protected_deck_indices(manifest: dict, current_id: int | None,
                            follow: int = CACHE_PROTECT_FOLLOW) -> set[int]:
    """受缓存清理保护的 deck 下标（manifest 顺序）：当前查看 Deck + 其后 follow 个。

    current_id 缺失 / 找不到 → 空集（不保护，走纯 LRU）。保护按「deck 顺序」而非 mtime——
    否则 mtime 乱序（批量渲染/插队）会让「紧挨当前的下一个 deck」因较旧 mtime 被误清。"""
    if current_id is None:
        return set()
    id_to_idx = {d["id"]: i for i, d in enumerate(manifest["decks"])}
    ci = id_to_idx.get(current_id)
    if ci is None:
        return set()
    return set(range(ci, min(ci + follow + 1, len(manifest["decks"]))))


def _enforce_cache_limit(manifest: dict, rendered_dir: Path,
                         limit_bytes: int | None,
                         current_id: int | None = None) -> bool:
    """缓存总量管理：rendered/ 超过 limit_bytes 时，按「最久未写入」（mtime 最小）顺序清理
    已就绪 Deck 的渲染产物（删目录 + 版本标记 evicted → 不再自动重渲，仅被优先级请求时重渲）。

    - 保护窗：当前查看 Deck 及其后 CACHE_PROTECT_FOLLOW 个（按 deck 顺序）不清——清理顺位
      轮到保护窗时先休息，待用户看过后（current.json 变化，保护窗前移）再恢复正常清理。
    - 返回是否发生了清理（调用方需要据此落盘）。limit_bytes=None 表示无限制。"""
    if limit_bytes is None:
        return False
    if not rendered_dir.is_dir():
        return False
    total = _dir_size(rendered_dir)
    if total <= limit_bytes:
        return False
    protected = _protected_deck_indices(manifest, current_id)
    candidates = _cache_candidates(manifest, rendered_dir)
    changed = False
    for _, di, deck, dirs in candidates:
        if total <= limit_bytes:
            break
        if di in protected:
            # 清理顺位轮到保护窗（当前查看 + 其后数个）：先休息（不清），等看完再正常清理
            break
        size = sum(_dir_size(d) for d in dirs)
        for d in dirs:
            shutil.rmtree(d, ignore_errors=True)
        total -= size
        for v in deck["versions"]:
            v["status"] = STATUS_PENDING
            v["evicted"] = True
            v["page_count"] = 0
            v["pages"] = []
            v.pop("error", None)
        changed = True
    if changed:
        finalize_deck_statuses(manifest)   # 重算 deck 状态与 evicted 标记
    return changed


def _cache_blocked(manifest: dict, rendered_dir: Path,
                   limit_bytes: int | None, current_id: int | None) -> bool:
    """缓存「休息」全局阻塞判定：缓存超限，且即使清掉所有「保护窗外」的可清理 deck，
    剩余（保护窗：当前查看 Deck + 其后数个）仍超限 → 无法再为 ahead 腾位 → 暂停渲染，
    等用户看完（current.json 变化）再恢复——避免渲染太快把没看的 deck 渲出来又被清理
    （「后面的没看完就被清理了」）。"""
    if limit_bytes is None or not rendered_dir.is_dir():
        return False
    total = _dir_size(rendered_dir)
    if total <= limit_bytes:
        return False
    protected = _protected_deck_indices(manifest, current_id)
    if not protected:
        return False
    prot_total = 0
    for _, di, deck, dirs in _cache_candidates(manifest, rendered_dir):
        if di in protected:
            prot_total += sum(_dir_size(d) for d in dirs)
    return prot_total > limit_bytes


def load_priority(data_dir: Path) -> list[int]:
    """读取前端写入的优先级请求（data_dir/priority.json），返回优先渲染的 deck_id 列表（保持顺序）。

    文件形如 {"deck_ids": [5, 9], "updated_at": "..."}；缺失 / 损坏时返回空列表（尽力而为）。
    前端经 FS Access 原子写（tmp+move），读端不会看到半成品。"""
    path = data_dir / "priority.json"
    if not path.is_file():
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("deck_ids") if isinstance(data, dict) else None
        return [int(i) for i in raw] if raw else []
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []


def _prune_priority(data_dir: Path, manifest: dict) -> None:
    """自动清理 priority.json 里「已就绪 / 已不存在」的 deck_id（后端兜底，避免 stale 条目
    持续把其后 Deck 提到最前）。只读-过滤-有变化才原子写；evicted（需按需重渲）的保留。

    前端在「打开就绪 Deck」时也会清（clearPriority），此处是每轮渲染后的自动兜底。"""
    path = data_dir / "priority.json"
    if not path.is_file():
        return
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("deck_ids") if isinstance(data, dict) else None
        ids = [int(i) for i in raw] if raw else []
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return
    if not ids:
        return
    valid = {d["id"] for d in manifest["decks"]}
    ready = {d["id"] for d in manifest["decks"]
             if d.get("status") == STATUS_READY or not (d.get("versions") or [])}
    keep = [i for i in ids if i in valid and i not in ready]
    if keep == ids:
        return
    try:
        atomic_write_json(path, {"deck_ids": keep, "updated_at": now_iso()})
    except OSError:
        pass   # 尽力而为：写失败不影响正常渲染


def _priority_front_deck_indices(manifest: dict, priority_ids: list[int],
                                 follow: int) -> list[int]:
    """应排最前的 deck 下标（按 manifest 顺序）：每个优先级 deck 连同其后 follow 个 deck。"""
    id_to_idx = {deck["id"]: i for i, deck in enumerate(manifest["decks"])}
    out: list[int] = []
    seen: set[int] = set()
    n = len(manifest["decks"])
    for pid in priority_ids or []:
        i = id_to_idx.get(pid)
        if i is None:
            continue
        for j in range(i, min(i + follow + 1, n)):
            if j not in seen:
                seen.add(j)
                out.append(j)
    return out


def order_pending_by_priority(pending: list[tuple], manifest: dict,
                              priority_ids: list[int] | None,
                              follow: int = PRIORITY_FOLLOW_DEFAULT) -> list[tuple]:
    """稳定排序：优先级 deck 连同其后 follow 个 deck 的待渲染任务排到最前（按 manifest 顺序），
    其余保持原序（供插队渲染——用户在某 Deck 等待时顺带把后面几个也先渲了）。"""
    if not priority_ids:
        return pending
    front = _priority_front_deck_indices(manifest, priority_ids, follow)
    if not front:
        return pending
    front_set = set(front)
    # (0, di)：前部 deck 按 manifest 下标升序；其余 (1, 0) 相等 → 稳定保持原序
    return sorted(pending, key=lambda item: (0, item[0]) if item[0] in front_set else (1, 0))


def select_render_batch(manifest: dict, rendered_dir: Path, dpi: int, thumb_width: int,
                        soffice: str, priority_ids: list[int] | None = None,
                        max_render: int | None = None,
                        priority_follow: int = PRIORITY_FOLLOW_DEFAULT) -> tuple[list[tuple], int]:
    """构建本轮待渲染任务（跳过已就绪），按优先级排前、可选按批截断。

    - priority_ids：优先渲染的 deck_id（连同其后 priority_follow 个 deck 排最前）
    - max_render：每轮最多渲染的版本数（None=全部；watch 模式用小批让优先级能尽快插队）
    - 被缓存清理（evicted）的版本默认不自动重渲，仅当该 Deck 位于「插队前部」（优先级本身
      或其顺带 follow 的 Deck）时才重渲（并清除 evicted）——点某清理 Deck 时其后的也一并重渲。
    只把「选中」的版本标记为 rendering（未选中保持 pending）。
    返回 (pending_jobs, 本轮之后剩余未选中版本数)。"""
    ds_name = {d["id"]: d["name"] for d in manifest["datasets"]}
    # 优先级 Deck + 其后 priority_follow 个（顺带预热）都在「插队前部」：
    # 它们即使被缓存清理（evicted）也应随优先级一并重渲，避免「点了某清理 Deck，
    # 其后的 Deck 仍迟迟不渲染」。
    front = set(_priority_front_deck_indices(manifest, priority_ids, priority_follow))
    all_pending: list[tuple] = []
    for di, deck in enumerate(manifest["decks"]):
        for vi, v in enumerate(deck["versions"]):
            if v.get("status") == STATUS_READY:
                continue
            if v.get("evicted") and di not in front:
                continue   # 已清理缓存：非优先级/其顺带组不自动重渲
            out_dir = rendered_dir / ds_name[v["dataset_id"]] / deck["name"]
            all_pending.append((di, vi, {
                "file_path": v["file_path"],
                "out_dir": str(out_dir),
                "dpi": dpi,
                "thumb_width": thumb_width,
                "soffice": soffice,
            }))
    all_pending = order_pending_by_priority(all_pending, manifest, priority_ids,
                                            follow=priority_follow)
    if max_render is not None and len(all_pending) > max_render:
        pending = all_pending[:max_render]
    else:
        pending = all_pending
    remaining = len(all_pending) - len(pending)
    for di, vi, _ in pending:
        v = manifest["decks"][di]["versions"][vi]
        v["status"] = STATUS_RENDERING
        v.pop("evicted", None)   # 优先级重渲：清除缓存清理标记
        manifest["decks"][di].pop("evicted", None)
    return pending, remaining


def _count_pending_versions(manifest: dict) -> int:
    """manifest 中仍为 pending 且未被缓存清理（evicted）的版本数
    （watch 循环据此判断是否还有活可干；evicted 只按需重渲，不占「活」）。"""
    return sum(1 for deck in manifest["decks"] for v in deck["versions"]
               if v.get("status") == STATUS_PENDING and not v.get("evicted"))


def _load_status_json(meta_dir: Path) -> dict | None:
    """读取现有 status.json（无 / 损坏返回 None）。"""
    p = meta_dir / "status.json"
    if not p.is_file():
        return None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _status_needs_update(old: dict | None, new: dict) -> bool:
    """新 status 是否需要在「无渲染」路径落盘（只比较有意义字段，忽略 updated_at）。"""
    if old is None:
        return True
    for k in ("active", "total", "ready", "rendering", "failed", "batch", "batch_cli"):
        if old.get(k) != new.get(k):
            return True
    return False


def run_render(
    cfg: dict,
    config_path: Path,
    jobs: int,
    dpi: int,
    thumb_width: int,
    soffice: str,
    active: bool,
    max_render: int | None = None,
    batch: int | None = None,
    batch_cli: bool = False,
) -> dict:
    """执行一次渲染 pass：合并旧状态 → 按优先级/批选择待渲染 → 渲染 → 逐结果更新 manifest/status。

    输出目录跟随 config 所在目录（meta/、rendered/ 都写到所选 data 目录内）。
    max_render：每轮最多渲染的版本数（None=全部）；返回含 rendered（本轮渲染数）与
    remaining（本轮后仍 pending 的版本数，供 watch 循环判断是否立即继续下一批）。"""
    data_dir, meta_dir, rendered_dir = _dirs_from_config(config_path, cfg)
    manifest_path = meta_dir / "manifest.json"
    manifest = build_or_merge_manifest(cfg, config_path, manifest_path, data_dir)
    finalize_deck_statuses(manifest)
    # config 变更后清理孤儿产物（在标记渲染中之前，不会误删本轮要渲染的目录）
    _cleanup_orphan_renders(manifest, rendered_dir)

    prefs = cfg.get("prefs") or {}
    priority_follow = int(prefs.get("priority_follow") or PRIORITY_FOLLOW_DEFAULT)
    cache_limit = parse_cache_limit(prefs.get("cache_limit"))
    # 注：当前查看 Deck（data/current.json）不在此处缓存——每次执行缓存清理前都重新读，
    #     以反映渲染期间用户切换 Deck 的最新状态（避免误清正在看的 Deck）。
    # 自动清理 priority.json 里已就绪/已不存在的 deck_id（避免 stale 优先级持续把
    # 其后 Deck 提到最前）；随后本轮的 load_priority 即读到清理后的列表。
    _prune_priority(data_dir, manifest)

    # 缓存「休息」全局阻塞：watch 模式下缓存超限且清理顺位轮到当前查看 deck（且无插队请求）
    # → 暂停继续渲染，等用户看完（current.json 变化）再恢复——避免渲染太快把没看的 deck
    # 渲染出来、随后又被缓存上限清理掉。one-shot（active=False）不阻塞；有 priority 插队请求时放行。
    priority_ids = load_priority(data_dir)
    blocked = (active and not priority_ids
               and _cache_blocked(manifest, rendered_dir, cache_limit,
                                  load_current_deck(data_dir))
               and _count_pending_versions(manifest) > 0)
    if blocked:
        old = load_existing_manifest(manifest_path)
        if old is not None and old == manifest:
            status = build_status_from_manifest(manifest, active, batch, batch_cli)
            old_status = _load_status_json(meta_dir)
            if _status_needs_update(old_status, status):
                meta_dir.mkdir(parents=True, exist_ok=True)
                atomic_write_json(meta_dir / "status.json", status)   # 只更新 active 等，不 bump version
        else:
            status = _persist(manifest, active, meta_dir, batch, batch_cli)
        return {"manifest": manifest, "status": status,
                "rendered": 0, "remaining": _count_pending_versions(manifest),
                "blocked": True}

    pending, remaining = select_render_batch(
        manifest, rendered_dir, dpi, thumb_width, soffice,
        priority_ids=priority_ids, max_render=max_render,
        priority_follow=priority_follow,
    )

    # 无变化（无待渲染且 manifest 与磁盘一致）→ 不重写 manifest，保持 version 稳定；
    # 但 watch 模式仍要确保 active 标志落盘（否则上次单次渲染的 active=false 会残留，
    # 前端误报「未以 --watch 运行」）。version 不变 → 前端不会重读大 manifest。
    old = load_existing_manifest(manifest_path)
    if not pending and old is not None and old == manifest:
        # 缓存清理前重新读 current.json：渲染期间用户可能已换到别的 Deck，
        # 用最新「当前查看」做休息保护，避免误清正在看的 Deck
        if _enforce_cache_limit(manifest, rendered_dir, cache_limit,
                                load_current_deck(data_dir)):
            # 缓存清理改变了清单 → 落盘（version 自增，前端会重读）
            status = _persist(manifest, active, meta_dir, batch, batch_cli)
        else:
            status = build_status_from_manifest(manifest, active, batch, batch_cli)
            old_status = _load_status_json(meta_dir)
            if _status_needs_update(old_status, status):
                meta_dir.mkdir(parents=True, exist_ok=True)
                atomic_write_json(meta_dir / "status.json", status)   # 只更新 active 等，不 bump version
        return {"manifest": manifest, "status": status,
                "rendered": 0, "remaining": _count_pending_versions(manifest)}

    # 先落一次「渲染中」，前端可立即看到
    finalize_deck_statuses(manifest)
    _persist(manifest, active, meta_dir, batch, batch_cli)

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
            _persist(manifest, active, meta_dir, batch, batch_cli)

    finalize_deck_statuses(manifest)
    status = _persist(manifest, active, meta_dir, batch, batch_cli)
    # 同样在收尾清理前重新读当前查看 Deck（渲染期间可能已换组）
    if _enforce_cache_limit(manifest, rendered_dir, cache_limit,
                            load_current_deck(data_dir)):
        finalize_deck_statuses(manifest)
        status = _persist(manifest, active, meta_dir, batch, batch_cli)
    return {"manifest": manifest, "status": status,
            "rendered": len(pending), "remaining": _count_pending_versions(manifest)}


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

    cli_batch = max(0, args.batch)
    print(f"[ingest] watch 模式启动（间隔 {args.interval}s，每批 "
          f"{cli_batch if cli_batch else '自动(默认 8，可被 config prefs.batch 覆盖)'} 个版本，Ctrl+C 停止）")
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
        # 每批数量：CLI --batch 显式优先，否则取 config prefs.batch，默认 8
        batch = cli_batch if cli_batch > 0 else int((cfg.get("prefs") or {}).get("batch") or 0)
        if batch <= 0:
            batch = 8
        # 分批渲染：每批后重新读 priority.json → 用户等某 Deck 时能「插队」到最前；
        # 还有待渲染（remaining>0）→ 不 sleep 立即下一批；全部就绪（或只剩 failed/evicted）→ 退避等待。
        result = run_render(cfg, cfg_path, args.jobs, args.dpi, args.thumb_width, args.soffice,
                            active=True, max_render=batch, batch=batch, batch_cli=(cli_batch > 0))
        if result.get("blocked"):
            # 缓存「休息」全局阻塞：缓存已满且当前查看的 deck 在清理顺位前沿 →
            # 暂停渲染，等用户看完（current.json 变化）再继续，避免把没看的 deck 渲出来又被清理
            time.sleep(args.interval)
            continue
        if result.get("remaining", 0) > 0:
            continue
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
    parser.add_argument("--batch", type=int, default=0,
                        help="watch 模式每轮最多渲染的版本数（0=自动：取 config prefs.batch，默认 8）")
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
