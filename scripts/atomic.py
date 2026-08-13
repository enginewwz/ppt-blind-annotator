"""原子文件写入工具：临时文件 + os.replace，避免写一半/断电损坏。"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from typing import Any


def now_iso() -> str:
    """当前本地时间 ISO8601（带时区偏移），如 2026-08-13T10:00:00+08:00。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def atomic_write_text(path: str | os.PathLike[str], text: str) -> None:
    """把 text 原子写入 path（自动建目录）。"""
    path = os.path.abspath(os.fspath(path))
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # 原子替换
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: str | os.PathLike[str], obj: Any) -> None:
    """把对象序列化为 JSON 并原子写入 path（ensure_ascii=False 保留中文）。"""
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    atomic_write_text(path, text + "\n")
