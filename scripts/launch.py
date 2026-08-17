"""一键启动：后台运行 ingest --watch（增量渲染）+ 本地配置桥接 + 打开浏览器访问前端。

布局：
  watched/config.json   工作区根目录的「跟踪配置」——ingest 始终监听它（git 忽略）
  data/                 视为「外部数据目录」（含自己的 config.json / meta / rendered）

用法：
    python scripts/launch.py
        # 启动时把 watched/config.json 重置为空（防止上次会话残留污染新目录渲染）
        # → 启动本地 HTTP 桥接（127.0.0.1:8765，本进程内线程）+ ingest --watch + 打开前端。
        # 本命令会一直运行：按 Ctrl+C 停止（ingest 与桥接一起退出），无需单独 kill 子进程。
        # 前端打开某个 data 目录（如 data/）后，「⇥ 复制到工作区」（或自动）把其 config
        # 复制到 watched/config.json；config 的 data_dir 把渲染输出写回该目录 → 「写回渲染」。
        # 「⇤ 写回目录」把 watched/config.json 复制回当前 data 目录的 config.json。

浏览器：默认用系统默认浏览器打开（带 ?bridge=端口）。若需给 Chromium 系浏览器加参数
（如 WSLg 下的 `--enable-features=UseOzonePlatform --ozone-platform=wayland`），写在本地
git 忽略文件 `scripts/local_browser.py`（CHROME_EXTRA 列表）或环境变量 `PPT_BROWSER_EXTRA` 中；
云端仓库不含本地配置 → 自动用系统默认浏览器，不带该参数。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402
from scripts.atomic import atomic_write_json  # noqa: E402
from scripts.bridge import create_server  # noqa: E402


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
    parser = argparse.ArgumentParser(description="一键启动：后台 ingest + 本地桥接 + 打开前端")
    parser.add_argument("--config", default=None, help="配置文件路径（默认：工作区根目录 watched/config.json）")
    parser.add_argument("--jobs", type=int, default=0, help="渲染并行度（默认 CPU 核数）")
    parser.add_argument("--dpi", type=int, default=150, help="渲染 DPI")
    parser.add_argument("--batch", type=int, default=0, help="watch 每批最多渲染的版本数（0=默认 8）")
    parser.add_argument("--bridge-port", type=int, default=8765, help="本地配置桥接端口（0=关闭）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args(argv)

    # 本地配置桥接：前端经 HTTP 把外部目录 config 复制到工作区 config（ingest 始终监听它）。
    # 以「本进程内线程」运行：绑定失败在此处即报错（端口被占用会明确提示），
    # 且不再产生需要单独 kill 的子进程（Windows 上子进程可能静默退出导致 PID 找不到）。
    bridge_port = args.bridge_port
    if bridge_port > 0:
        try:
            bridge_server = create_server(bridge_port)
            threading.Thread(target=bridge_server.serve_forever, daemon=True).start()
            print(f"[launch] 本地桥接 http://127.0.0.1:{bridge_port}/config（前端 ?bridge={bridge_port}）")
        except OSError as e:
            print(f"[launch] 桥接启动失败：端口 {bridge_port} 可能被占用（请先停止旧的 launch/桥接）→ {e}")
            bridge_port = 0

    cfg = Path(args.config) if args.config else paths.WATCH_CONFIG_PATH
    # 默认（未显式 --config）：使用工作区根目录的「跟踪配置」watched/config.json。
    # 启动时总是重置为空 —— 防止上次会话残留污染新目录的渲染；前端打开某个 data 目录后
    # 会自动（或点「⇥ 复制到工作区」）把其 config 复制进来。
    if not args.config:
        try:
            cfg.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(cfg, {"datasets": [], "prefs": {"shuffle": False, "sync_page": True}})
            print(f"[launch] 已重置跟踪配置: {cfg}（watched/ 已在 .gitignore，不入库）")
        except Exception as e:  # noqa: BLE001
            print(f"[launch] 重置跟踪配置失败: {e}")
    cmd = [sys.executable, "-m", "scripts.ingest",
           "--config", str(cfg), "--watch"]
    if args.jobs:
        cmd += ["--jobs", str(args.jobs)]
    if args.dpi:
        cmd += ["--dpi", str(args.dpi)]
    if args.batch:
        cmd += ["--batch", str(args.batch)]
    proc = subprocess.Popen(
        cmd, cwd=paths.PROJECT_ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if cfg.is_file():
        print(f"[launch] ingest 后台进程 PID={proc.pid}（--watch，增量渲染）")
    else:
        print(f"[launch] ingest 后台进程 PID={proc.pid}（--watch，等待 config 创建: {cfg}）")

    index = paths.STATIC_DIR / "index.html"
    # 有桥接时由桥接同源伺服前端（http://127.0.0.1:<port>/）——fetch /config 同源，
    # 无 CORS / ?bridge= 参数丢失问题（Windows 下更稳）；否则退回 file:// 直开。
    if bridge_port > 0:
        uri = f"http://127.0.0.1:{bridge_port}/index.html"
    else:
        uri = index.resolve().as_uri()
    print(f"[launch] 前端: {uri}")
    if not args.no_browser:
        cmd = _browser_cmd(uri)
        if cmd:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"[launch] 浏览器: {cmd[0]}（读取本地额外参数）")
        else:
            webbrowser.open(uri)

    if proc:
        print("[launch] 正在运行：按 Ctrl+C 停止（ingest 与本地桥接一起退出）。")
        print("[launch] 若此前已渲染，本次会自动跳过（断点续跑）。")
    try:
        if proc:
            proc.wait()
        else:
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        if proc:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        print("[launch] 已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
