# PPT 盲测对照标注平台

纯前端（无后端）的 PPT 盲测对照标注工具：把同一份幻灯片（Deck）的多种生成方法（数据源 / 方法）并排展示，标注人**看不到来源**（仅显示「样本 N」），逐页对比、打分、选最优 / 最差，支持 1–5 分。数据存本地 JSON，浏览器通过 **File System Access API** 读写本地 `data/` 目录。

## 特性

- 目录授权一次，IndexedDB 记住句柄，刷新 / 重开自动恢复
- 侧栏 Deck 列表：快速跳转、状态徽标（待处理 ● / 草稿 ● / 完成 ✓）、筛选（全部 / 待完成 / 已完成）
- 标注画布：自由卡片（拖动 / 八向缩放 / 允许重叠 / 自动排列 / 1–4 列版式 / 滚轮翻页）
- 盲测约束：不显示数据源名，仅显示「样本 N」；可选随机顺序；同步翻页
- 保存时机：手动保存 + 切换 Deck / 关闭时自动 flush，未保存有关闭提醒
- 数据页：Deck×数据源矩阵 / 数据源汇总，按状态**多选**筛选，增删渲染组（写 `config.json`），一键刷新
- 清空标注（当前 / 全部）、标注导入导出、操作日志（localStorage）
- 后端增量渲染：`ingest --watch` 监视源文件变化自动重渲，断点续跑，原子写（读写并发安全，不产生半成品 / 碎片文件）

## 技术架构

```mermaid
flowchart LR
    subgraph 浏览器[浏览器 Chrome/Edge 打开 app/static/index.html]
        UI[标注界面 / 数据页]
        FS[File System Access API]
    end
    subgraph data[本地 data/ 目录]
        CFG[config.json]
        ANNO[annotations.json + history.jsonl]
        META[meta/manifest.json, status.json]
        RND[rendered/ 图片]
    end
    subgraph 后端[scripts/ Python 工具]
        ING[ingest.py --watch 增量渲染]
        REN[render.py soffice→pdf→WebP]
    end
    UI --> FS
    FS --> CFG
    FS --> ANNO
    FS --> META
    FS --> RND
    ING --> REN
    ING --> META
    ING --> RND
    ING --> CFG
```

- 前端：`app/static/`，无构建步骤，直接打开 `index.html`
- 后端：`scripts/`，仅做渲染 / 建清单，不提供 HTTP
- 运行产物与本地配置（`data/`、`reports/`、`tests/`、`docs/.build/`、`pytest.ini` 等）已 git 忽略，不入库

## 目录结构

```
ppt-blind-annotator/
├─ app/static/                # 前端（无构建）
│  ├─ index.html
│  ├─ css/app.css
│  └─ js/
│     ├─ fsaccess.js          # FS Access 封装（授权/读写/原子写/追加）
│     ├─ app.js               # 入口、路由、数据页、操作日志
│     ├─ annotate.js          # 标注画布（卡片/翻页/保存）
│     ├─ explorer.js          # 侧栏 Deck 列表
│     └─ report.js            # 报告视图（M3）
├─ scripts/                   # Python 工具
│  ├─ ingest.py               # 扫描/归组/渲染/建清单，--watch 增量
│  ├─ render.py               # soffice→pdf→PyMuPDF→WebP（staging 提交）
│  ├─ launch.py               # 一键启动：ingest --watch + 打开浏览器
│  ├─ make_demo.py            # 生成 4 组演示 pptx
│  ├─ atomic.py               # 原子写（os.replace）
│  ├─ paths.py / constants.py
├─ requirements.txt
└─ README.md                  # 本文档（人类可读总文档）
```

## 快速开始

1. **安装依赖**
   - 系统：`libreoffice`（提供 `soffice`，渲染用）
   - Python：`pip install -r requirements.txt`（pymupdf / Pillow / python-pptx / pytest / unoserver）

2. **准备数据**（二选一）
   - 用现成源文件：构造 `data/config.json`（构造示例见下）指向各数据源目录
   - 或生成演示数据：`python scripts/make_demo.py`

3. **启动**
   - 一键：`python scripts/launch.py`
     把工作区根目录的**跟踪配置** `watched/config.json` **重置为空**（`watched/` 已在 `.gitignore`）、
     启动**本地配置桥接**（`127.0.0.1:8765`，**同源伺服前端**）+ `ingest --watch` 增量渲染 +
     打开前端（`http://127.0.0.1:8765/`）。前台常驻，**Ctrl+C 一起停止**。
   - 或手动：`python -m scripts.ingest --config watched/config.json --watch`，再打开 `http://127.0.0.1:8765/`（桥接在跑时）或 `app/static/index.html`（file://，无桥接功能）

4. **授权 / 选择数据目录**：页面首次打开时点右上角「data 目录」（或底部目录 chip），选择某个 data 目录（工作区 `data/` 即模拟外部目录；也可选真外部目录）。打开后若跟踪配置为空会自动复制，或点**「⇥ 复制到工作区」**——把该目录的 config 复制到 `watched/config.json`，ingest 检测到变化即渲染（输出写回该目录）。

> **工作区根目录 `watched/config.json` 是 ingest 始终监听的对象**（启动时被重置为空，防止残留污染新目录渲染）；
> config 里的 `data_dir` 字段把渲染输出写回对应的外部目录（前端从绝对路径自动推导，或外部 config 自带），
> 因此「写回渲染」落到该目录、前端直读。数据页 **「⇤ 写回目录」**把 `watched/config.json` 复制回当前目录。
> 未用 `launch.py` 启动（无 `?bridge=`）时这两个按钮不可用，页面会提示。
> 若未运行 `--watch`，页面顶部会显示提示，此时只能「加载 / 编辑」，不会生成 meta / 渲染。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `python scripts/launch.py` | 一键：重置 watched/config.json → 本地桥接 + ingest --watch + 开前端 |
| `python -m scripts.bridge --port 8765` | 本地配置桥接（前端↔watched/config.json；一般由 launch.py 自动启动） |
| `python -m scripts.ingest --config watched/config.json --watch` | 增量渲染，持续监视（默认即 watched） |
| `python -m scripts.ingest --config <配置路径>` | 单次渲染后退出 |
| `python scripts/make_demo.py` | 生成 4 组演示 pptx（methodA~D） |
| `kill <ingest_pid>` | 停止 ingest --watch |

### 浏览器打开参数（本地可选）

`launch.py` 默认用系统默认浏览器打开前端。若需给 Chromium 系浏览器附加参数（如 WSLg 下
`--enable-features=UseOzonePlatform --ozone-platform=wayland`），写在**本地 git 忽略**文件
`scripts/local_browser.py`（`CHROME_EXTRA` 列表）或环境变量 `PPT_BROWSER_EXTRA` 中；
云端仓库不含本地配置 → 自动用系统默认浏览器，不带这些参数。

## 数据目录构造示例

> `data/` 等为运行产物目录，不入库；此处给出**构造方式示例**，便于新环境重建。

```jsonc
// data/config.json —— 数据源列表（渲染组）+ 全局偏好
// 视 data/ 为「外部目录」：data_dir 指向本目录（绝对路径），数据集 path 相对它
{
  "data_dir": "/abs/path/to/data",
  "datasets": [
    { "name": "methodA", "path": "demo/methodA", "sort_order": 0 },
    { "name": "methodB", "path": "demo/methodB", "sort_order": 1 }
  ],
  "prefs": { "shuffle": false, "sync_page": true }
}
```

```
watched/                       # 工作区根目录「跟踪配置」——ingest 始终监听（git 忽略）
└─ config.json                 # 由前端「⇥ 复制到工作区」写入；launch.py 启动时重置为空

data/                          # 视为「外部数据目录」——前端打开它，渲染写回它
├─ config.json                 # 上例（自描述：data_dir + 相对数据集路径）
├─ annotations.json            # 当前标注（前端首次保存时自动创建）
├─ annotations_history.jsonl   # 标注历史追加日志（前端首次重审时自动创建）
├─ demo/                       # 源 pptx（路径相对 data_dir）
│  ├─ methodA/slide_001.pptx
│  ├─ methodA/slide_002.pptx
│  └─ methodB/...
├─ meta/                       # ingest 生成（manifest.json / status.json）
└─ rendered/                   # ingest 生成：<数据源>/<Deck>/page_*.webp
```

## 里程碑状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 骨架 | 扫描 / 归组 / 建清单（manifest/status） | ✅ 已完成 |
| M1 渲染管线 | soffice→pdf→WebP 增量渲染、断点续跑、原子写 | ✅ 已完成 |
| M2 标注前端 | 盲测画布 + Deck 列表 + 数据页 | ✅ 已完成 |
| M3 报告生成 | report.py 聚合输出 HTML/CSV/JSON | ⬜ 下一步 |
| M4 性能与打包 | 虚拟滚动、千级懒加载、压测 | ⬜ 未开始 |

> 面向后续开发的详细文档（规划 / 进度 / 交接）在 `docs/.build/`（git 忽略，不入库）。
