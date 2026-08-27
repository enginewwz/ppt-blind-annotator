"""项目路径解析（以脚本所在目录的上级为项目根）。"""
from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 工作区根目录的「跟踪配置」目录——ingest 始终监听它（git 忽略）。
# data/ 视为「外部数据目录」（含自己的 config.json / meta / rendered）。
WATCH_DIR = PROJECT_ROOT / "watched"
WATCH_CONFIG_PATH = WATCH_DIR / "config.json"

# 数据目录（浏览器与 CLI 共享；data/ 模拟外部目录）
DATA_DIR = PROJECT_ROOT / "data"
META_DIR = DATA_DIR / "meta"
RENDERED_DIR = DATA_DIR / "rendered"

# 前端静态页
STATIC_DIR = PROJECT_ROOT / "app" / "static"

# 报告输出
REPORTS_DIR = PROJECT_ROOT / "reports"

# 关键文件
CONFIG_PATH = DATA_DIR / "config.json"
STATUS_PATH = META_DIR / "status.json"
MANIFEST_PATH = META_DIR / "manifest.json"
