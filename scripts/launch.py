"""一键启动：后台运行 ingest --watch（增量渲染）+ 打开浏览器访问前端。

用法：
    python scripts/launch.py [--config data/config.json]

浏览器：默认用系统默认浏览器打开。若需给 Chromium 系浏览器加参数（如 WSLg 下的
`--enable-features=UseOzonePlatform --ozone-platform=wayland`），写在本地 git 忽略文件
`scripts/local_browser.py`（CHROME_EXTRA 列表）或环境变量 `PPT_BROWSER_EXTRA` 中；
云端仓库不含本地配置 → 自动用系统默认浏览器，不带该参数。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402


def _browser_cmd(index_uri: str) -> list[str] | None:
    """返回 Chromium 系浏览器的启动命令（含本地额外参数）；无参数或找不到浏览器则返回 None。

    本地额外参数从两处读取（均为本地、不入库）：
      1. `scripts/local_browser.py` 的 CHROME_EXTRA 列表；
      2. 环境变量 `PPT_BROWSER_EXTRA`（空格分隔）。
    """
    extra: list[str] = []
    try:
        from scripts import local_browser  # type: ignore  # 仅本地存在（git 忽略）
        extra = list(getattr(local_browser, "CHROME_EXTRA", []) or [])
    except ImportError:
        pass
    if not extra:
        extra = os.environ.get("PPT_BROWSER_EXTRA", "").split()
    if not extra:
        return None
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
                 "microsoft-edge", "microsoft-edge-stable"):
        p = shutil.which(name)
        if p:
            return [p, *extra, index_uri]
    return None


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
        uri = index.resolve().as_uri()
        cmd = _browser_cmd(uri)
        if cmd:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"[launch] 浏览器: {cmd[0]}（读取本地额外参数）")
        else:
            webbrowser.open(uri)

    print("[launch] 提示：停止 ingest 可用 `kill " + str(proc.pid) + "`；"
          "若此前已渲染，本次会自动跳过（断点续跑）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
