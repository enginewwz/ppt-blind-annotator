# PPT 盲测对照标注平台

纯前端（无后端）的 PPT 盲测对照标注工具：把同一份幻灯片（Deck）的多种生成方法（数据源 / 方法）并排展示，标注人**看不到来源**（仅显示「样本 N」），逐页对比、打分、选最优 / 最差，支持 1–5 分。数据存本地 JSON，浏览器通过 **File System Access API** 读写本地数据目录。

## 特性

- 目录授权一次，IndexedDB 记住句柄，刷新 / 重开自动恢复
- 侧栏 Deck 列表：快速跳转、状态徽标（待处理 ● / 草稿 ● / 完成 ✓）、筛选（全部 / 待完成 / 已完成）、**虚拟滚动**（数百~上千 Deck 只渲染可见窗口）
- 标注画布：自由卡片（拖动 / 八向缩放 / 允许重叠 / 自动排列 / 1–4 列版式 / 滚轮翻页）
- 盲测约束：不显示数据源名，仅显示「样本 N」；可选随机顺序；同步翻页
- 保存时机：手动保存 + 切换 Deck / 关闭时自动 flush，未保存有关闭提醒
- 数据页：Deck×数据源矩阵 / 数据源汇总，按状态**多选**筛选，增删渲染组（写 `config.json`），一键刷新
- 清空标注（当前 / 全部）、标注导入导出、操作日志（localStorage）
- 后端增量渲染：`ingest --watch` 监视源文件变化自动重渲，断点续跑，原子写（读写并发安全，不产生半成品 / 碎片文件）
- **插队渲染**：点未就绪 Deck 即请求优先渲染（写 `priority.json`），`ingest --watch` 分批渲染、优先级 Deck 连同其后几个 Deck 一起排最前——跳过到某 Deck 等待时它（及后面几个）先出图
- **缓存总量管理**：数据页侧栏设缓存上限（100M / 300M / 500M / 1G / 无限制）与每批数量；rendered/ 超出上限自动清理最旧的 Deck（标记 evicted，需重看时点它即优先重渲）。清理有**保护窗**：当前查看的 Deck 及其后几个（按 Deck 顺序）不会被清；若保护窗本身已超限则**全局暂停渲染**，看完后再继续（避免渲染太快把没看的清掉）
- **报告视图**：浏览器内实时聚合（每数据源分布 / 均值 / 中位数 / 方差 / 最佳 / 最差 + 逐 Deck 明细），可**一键导出自包含静态网页 report.html**（无 CDN）；完整离线 HTML/CSV/JSON 由 `report.py` 生成

## 技术架构

```mermaid
flowchart LR
    subgraph 浏览器[浏览器 Chrome/Edge 打开 app/static/index.html]
        UI[标注界面 / 数据页]
        FS[File System Access API]
    end
    subgraph 工作区[工作区根目录]
        WCFG[watched/config.json]
    end
    subgraph scripts[scripts/ Python 工具]
        BR[bridge.py 本地桥接 127.0.0.1:8765]
        ING[ingest.py --watch 增量渲染]
        REN[render.py soffice→pdf→WebP]
    end
    subgraph data[本地数据目录]
        CFG[config.json]
        ANNO[annotations.json]
        HIST[annotations_history.jsonl]
        CTL[priority.json / current.json]
        META[meta/manifest.json, status.json]
        RND[rendered/ 图片]
    end
    UI -->|FS Access| FS
    FS --> CFG
    FS --> ANNO
    FS --> HIST
    FS --> CTL
    FS --> META
    FS --> RND
    UI -->|配置复制/写回| BR
    BR --> WCFG
    ING -->|监听| WCFG
    ING --> REN
    ING --> META
    ING --> RND
    ING --> CTL
```

- 前端：`app/static/`，无构建步骤，直接打开 `index.html`
- 后端：`scripts/`，负责渲染 / 建清单 / 报告与本地配置桥接；桥接仅监听 `127.0.0.1`，不对外提供服务
- 运行产物与本地配置不入库

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
│     └─ report.js            # 报告视图
├─ scripts/                   # Python 工具
│  ├─ ingest.py               # 扫描/归组/渲染/建清单，--watch 增量
│  ├─ render.py               # soffice→pdf→PyMuPDF→WebP（staging 提交）
│  ├─ report.py               # 聚合标注 → reports/report.{json,csv,html}
│  ├─ bridge.py               # 本地配置桥接（127.0.0.1，前端↔watched/config.json）
│  ├─ launch.py               # 一键启动：本地桥接 + ingest --watch + 打开浏览器
│  ├─ atomic.py               # 原子写（os.replace）
│  ├─ paths.py / constants.py
├─ requirements.txt
└─ README.md
```

## 快速开始

1. **安装依赖**
   - 系统：`libreoffice`（提供 `soffice`，渲染用）
   - Python：`pip install -r requirements.txt`（pymupdf / Pillow / python-pptx / pytest / unoserver）

2. **准备数据**：用现成源文件，构造一份 `config.json`（构造示例见下）指向各数据源目录

3. **启动**
   - 一键：`python scripts/launch.py`
     默认做**路径匹配**检查：上次的跟踪配置 `watched/config.json`（`watched/` 已在 `.gitignore`）
     仍指向已存在的数据集目录（是之前的数据集）→ **保留不清空**、ingest 断点续跑；
     路径失效 / 换新目录 / 空配置 → 重置为空防残留污染；`--reset-config` 强制清空。
     同时启动**本地配置桥接**（`127.0.0.1:8765`，**同源伺服前端**）+ `ingest --watch` 增量渲染 +
     打开前端（`http://127.0.0.1:8765/`）。前台常驻，**Ctrl+C 一起停止**。
   - 或手动：`python -m scripts.ingest --config watched/config.json --watch`，再打开 `http://127.0.0.1:8765/`（桥接在跑时）或 `app/static/index.html`（file://，无桥接功能）

4. **授权 / 选择数据目录**：页面首次打开时点右上角「data 目录」（或底部目录 chip），选择标注数据所在目录。打开后若跟踪配置为空会自动复制，或点**「⇥ 复制到工作区」**——把该目录的 config 复制到 `watched/config.json`，ingest 检测到变化即渲染（输出写回该目录）。

> **工作区根目录 `watched/config.json` 是 ingest 始终监听的对象**（launch.py 启动先做路径匹配：仍是之前的数据集则保留续跑，否则重置为空防残留污染）；
> config 里的 `data_dir` 字段把渲染输出写回对应的外部目录（前端从绝对路径自动推导，或外部 config 自带），
> 因此「写回渲染」落到该目录、前端直读。数据页 **「⇤ 写回目录」**把 `watched/config.json` 复制回当前目录。
> 未用 `launch.py` 启动（无 `?bridge=`）时这两个按钮不可用，页面会提示。
> 若未运行 `--watch`，页面顶部会显示提示，此时只能「加载 / 编辑」，不会生成 meta / 渲染。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `python scripts/launch.py` | 一键：路径匹配→保留/重置 watched/config.json（`--reset-config` 强制清空）→ 本地桥接 + ingest --watch + 开前端 |
| `python -m scripts.bridge --port 8765` | 本地配置桥接（前端↔watched/config.json；一般由 launch.py 自动启动） |
| `python -m scripts.ingest --config watched/config.json --watch` | 增量渲染，持续监视（默认即 watched） |
| `python -m scripts.ingest --config <配置路径>` | 单次渲染后退出 |
| `python -m scripts.ingest --config watched/config.json --watch` | 增量渲染，持续监视；每批数量 = `--batch` 显式值，否则取 config `prefs.batch`，默认 8 |
| `python scripts/report.py` | 聚合标注生成报告 `reports/report.{json,csv,html}`（HTML 含柱状图与 `#/deck/<id>` 回链） |
| `kill <ingest_pid>` | 停止 ingest --watch |

### 浏览器打开参数（本地可选）

`launch.py` 默认用系统默认浏览器打开前端。若需给 Chromium 系浏览器附加参数（如 WSLg 下
`--enable-features=UseOzonePlatform --ozone-platform=wayland`），写在**本地 git 忽略**文件
`scripts/local_browser.py`（`CHROME_EXTRA` 列表）或环境变量 `PPT_BROWSER_EXTRA` 中；
云端仓库不含本地配置 → 自动用系统默认浏览器，不带这些参数。

## 数据目录构造示例

> 此处给出**构造方式示例**，便于新环境重建。

```jsonc
// config.json —— 数据源列表（渲染组）+ 全局偏好
// 数据目录自描述：data_dir 指向本目录（绝对路径），数据集 path 相对它
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
└─ config.json                 # 由前端「⇥ 复制到工作区」写入；launch.py 启动时做路径匹配（是之前的数据集则保留，否则重置为空）

数据目录/                     # 前端打开它，渲染写回它（示例名，可任取）
├─ config.json                 # 数据源列表 + 全局偏好（见上例；自描述：data_dir + 相对数据集路径）
├─ annotations.json            # 当前标注（前端首次保存时自动创建）
├─ annotations_history.jsonl   # 标注历史追加日志（前端首次「改判重审」时自动创建；全新数据未必立即出现）
├─ priority.json               # 插队渲染请求（点未就绪 Deck 时前端写入 deck_ids）
├─ current.json                # 当前查看 Deck（打开 Deck 时前端写入，缓存清理「保护窗」定位用）
├─ demo/                       # 源 pptx（路径相对 data_dir）
│  ├─ methodA/slide_001.pptx
│  ├─ methodA/slide_002.pptx
│  └─ methodB/...
├─ meta/                       # ingest 生成（manifest.json / status.json）
└─ rendered/                   # ingest 生成：<数据源>/<Deck>/page_*.webp
```
