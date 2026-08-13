"""一键启动：后台运行 ingest --watch（增量渲染）+ 打开浏览器访问前端。

用法：
    python scripts/launch.py [--config data/config.json]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="一键启动：后台 ingest + 打开前端")
    parser.add_argument("--config", default=str(paths.CONFIG_PATH), help="配置文件路径")
    parser.add_argument("--jobs", type=int, default=0, help="渲染并行度（默认 CPU 核数）")
    parser.add_argument("--dpi", type=int, default=150, help="渲染 DPI")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args(argv)

    cfg = Path(args.config)
    if not cfg.is_file():
        print(f"[launch] 未找到配置文件: {cfg}")
        print("         请先创建 data/config.json（可参考 data/config.example.json）")
        return 2

    cmd = [sys.executable, "-m", "scripts.ingest",
           "--config", str(cfg), "--watch"]
    if args.jobs:
        cmd += ["--jobs", str(args.jobs)]
    if args.dpi:
        cmd += ["--dpi", str(args.dpi)]

    proc = subprocess.Popen(
        cmd, cwd=paths.PROJECT_ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"[launch] ingest 后台进程 PID={proc.pid}（--watch，增量渲染）")

    index = paths.STATIC_DIR / "index.html"
    print(f"[launch] 前端: {index}")
    if not args.no_browser:
        webbrowser.open(index.resolve().as_uri())

    print("[launch] 提示：停止 ingest 可用 `kill " + str(proc.pid) + "`；"
          "若此前已渲染，本次会自动跳过（断点续跑）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
