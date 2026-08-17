/* 应用主入口：初始化、路由、数据加载、动态轮询、标注保存/导入导出。 */

/* 轻量操作日志：localStorage 存储，自动裁剪上限（有主动清理） */
const OpLog = {
  key: "ppt.oplog",
  max: 200,
  add(msg) {
    try {
      const arr = JSON.parse(localStorage.getItem(this.key) || "[]");
      arr.push({ t: new Date().toISOString(), m: String(msg).slice(0, 300) });
      localStorage.setItem(this.key, JSON.stringify(arr.slice(-this.max)));
    } catch (_) { /* ignore */ }
  },
  clear() { try { localStorage.removeItem(this.key); } catch (_) {} },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 标注内容是否实质相同（忽略 updated_at/submitted_at 时间戳）：
   用于判断是否真的改过，避免「仅翻页/移动/缩放」也触发落盘或历史日志 */
function sameAnno(a, b) {
  if (!a || !b) return !a && !b;
  return a.status === b.status && a.best === b.best && a.worst === b.worst &&
    JSON.stringify(a.scores || {}) === JSON.stringify(b.scores || {});
}

/* 绝对路径公共前缀（用于定位数据集容器目录） */
function absCommonPrefix(paths) {
  if (!paths.length) return "";
  let p = paths[0].split("/").filter(Boolean);
  paths.slice(1).forEach((s) => {
    const q = s.split("/").filter(Boolean);
    let i = 0;
    while (i < p.length && i < q.length && p[i] === q[i]) i++;
    p = p.slice(0, i);
  });
  return "/" + p.join("/");
}

/* 由多个绝对路径推导数据根（data_dir）：归一化反斜杠，取公共目录前缀。
   单条路径取父目录（避免根=数据集自身）。返回如 "C:/ext/data" 或 "/ext/data"。
   注意：仅作「没有 data_dir 字段时」的最佳猜测；外部 config 自带 data_dir 时以其为准。 */
function deriveDataRoot(paths) {
  const norm = paths.map((p) => String(p).replace(/\\/g, "/"));
  let parts = norm[0].split("/").filter(Boolean);
  if (norm.length === 1) {
    parts.pop();
  } else {
    for (let i = 1; i < norm.length; i++) {
      const q = norm[i].split("/").filter(Boolean);
      let j = 0;
      while (j < parts.length && j < q.length && parts[j] === q[j]) j++;
      parts = parts.slice(0, j);
    }
  }
  return parts.join("/");
}

/* 去掉路径前缀中的数据根，得相对路径；不在根下则原样返回（可能仍是绝对路径） */
function stripDataRoot(p, root) {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (s === r) return "";
  if (s.startsWith(r + "/")) return s.slice(r.length + 1);
  return s;
}

/* 全树扫描「直接含 pptx 的目录」并缓存；「目录 ⟳ 刷新」会清缓存强制重扫，实现增量发现新文件夹。
   重选 data 目录时也会清缓存。 */
let _srcDirsCache = null;
async function scanSourceDirs() {
  if (_srcDirsCache) return _srcDirsCache;
  let dirs = [];
  try { dirs = await FS.findSourceDirs(4); } catch (_) { /* ignore */ }
  _srcDirsCache = dirs.filter(Boolean);
  return _srcDirsCache;
}

/* 在 data/ 目录树下按名称查找目录，返回相对路径（跳过 rendered/，限制深度） */
async function findDirRel(targetName, maxDepth = 4) {
  const queue = [""];
  while (queue.length) {
    const cur = queue.shift();
    const depth = cur ? cur.split("/").length : 0;
    if (depth > maxDepth) continue;
    let entries;
    try { entries = await FS.listDir(cur); } catch (_) { continue; }
    for (const e of entries) {
      if (e.kind !== "directory") continue;
      if (e.name === "rendered") continue;
      if (e.name === targetName) return cur ? cur + "/" + e.name : e.name;
      queue.push(cur ? cur + "/" + e.name : e.name);
    }
  }
  return null;
}

const DS_LABEL = { ready: "就绪", rendering: "渲染中", pending: "待处理", failed: "失败" };

const Datasets = {
  statuses: new Set(),  // 空集合 = 全部
  axis: "deck",         // deck | dataset（纵轴）
  rendered: [],         // 正在渲染的文件夹名（来自 config.json）
  candidates: [],       // 备选文件夹 [{name, rel}]（可加入渲染；rel 为相对 data/ 的路径）
  candMap: {},          // name → {name, rel} 快速查找
  containerRel: "",     // 数据源容器相对 data/ 的路径（持久化，供全取消后重加拼路径）
  containerAbs: "",     // 数据源容器绝对路径（持久化）
  addSet: new Set(),    // 勾选要加入渲染的备选
  rmSet: new Set(),     // 勾选要取消渲染的现有组
  prefs: { cache_limit: "", batch: 0 },   // 渲染设置（缓存上限 / 每批数量，写进 config prefs）

  /* 扫描备选文件夹：合并「现有数据源所在目录的兄弟文件夹」+「data 目录下任意位置直接含 pptx 的文件夹」。
     二者合并后，无论新文件夹拖到 data 目录下的哪个位置都能被（增量）发现，
     且不强制任何子目录名（如 demo/）。路径一律为「相对 data 目录」，跨环境可迁移。 */
  async loadSidebar() {
    let cfg = null;
    try { cfg = await FS.readJSON("config.json"); } catch (_) { /* ignore */ }
    this.cfg = cfg || { datasets: [], prefs: {} };
    this.rendered = (this.cfg.datasets || []).map((d) => d.name);
    this.prefs = Object.assign({ cache_limit: "", batch: 0 }, this.cfg.prefs || {});
    const cfgDs = this.cfg.datasets || [];
    const seen = new Map();   // name → {name, rel} 去重池
    const addCand = (name, rel) => {
      if (!name || this.rendered.includes(name) || seen.has(name)) return;
      seen.set(name, { name, rel });
    };
    // 1) 容器扫描：现有数据源所在目录的兄弟文件夹（新源通常放同层，如 demo/methodB）
    if (cfgDs.length) {
      try {
        const relFirst = await findDirRel(cfgDs[0].name);
        if (relFirst) {
          this.containerRel = relFirst.split("/").slice(0, -1).join("/");
          const paths = cfgDs.map((d) => d.path).filter(Boolean);
          let ca = absCommonPrefix(paths);
          if (cfgDs.length === 1) {   // 单个数据源：公共前缀即它自身 → 容器取其父目录
            const i = ca.lastIndexOf("/");
            ca = i > 0 ? ca.slice(0, i) : "";
          }
          this.containerAbs = ca || "";
          try {
            localStorage.setItem("ppt.containerRel", this.containerRel);
            localStorage.setItem("ppt.containerAbs", this.containerAbs);
          } catch (_) { /* ignore */ }
          const entries = await FS.listDir(this.containerRel);
          for (const e of entries)
            if (e.kind === "directory")
              addCand(e.name, this.containerRel ? this.containerRel + "/" + e.name : e.name);
        }
      } catch (_) { /* ignore */ }
    }
    // 2) 全树扫描：data 目录下任意位置「直接含 pptx」的文件夹（外部拖入任意位置也能被发现）
    for (const rel of await scanSourceDirs()) {
      if (!rel) continue;
      addCand(rel.split("/").pop(), rel);
    }
    // 无数据源（或容器为空）时恢复持久化的容器，供全取消后重加拼路径
    if (!this.containerRel) {
      try {
        this.containerRel = localStorage.getItem("ppt.containerRel") || "";
        this.containerAbs = localStorage.getItem("ppt.containerAbs") || "";
      } catch (_) { /* ignore */ }
    }
    this.candidates = [...seen.values()];
    this.candMap = {};
    this.candidates.forEach((c) => { this.candMap[c.name] = c; });
  },

  async renderSidebar() {
    const el = document.getElementById("dataset-dir");
    const settingsEl = document.getElementById("ds-settings");
    const item = (group, nm, checked, extra) =>
      `<label class="ds-item ${extra}">
        <input type="checkbox" data-group="${group}" data-name="${escapeHtml(nm)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(nm)}</span>
      </label>`;
    const renderedHtml = this.rendered.map((n) =>
      item("rm", n, this.rmSet.has(n), this.rmSet.has(n) ? "rm" : "")).join("") ||
      '<div class="empty muted">（暂无渲染中的组）</div>';
    const candHtml = this.candidates.map((c) =>
      item("add", c.name, this.addSet.has(c.name), this.addSet.has(c.name) ? "add" : "")).join("") ||
      '<div class="empty muted">（无备选文件夹）</div>';
    const dirty = this.addSet.size + this.rmSet.size > 0;
    const opt = (cur, list) => list.map(([v, label]) =>
      `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${label}</option>`).join("");
    // CLI --batch 已指定（status.batch_cli）→ 每批下拉禁用并提示
    const batchLocked = !!(App.state.status && App.state.status.batch_cli);
    const settings =
      `<div class="ds-settings">
        <label class="ds-ctl" title="rendered/ 渲染产物总量上限：超出后自动清理最旧的 Deck（需重看时点它即优先重渲）">缓存限制
          <span class="sel-wrap">
            <select id="ds-cache-limit">${opt(this.prefs.cache_limit, [["", "无限制"], ["100M", "100M"], ["300M", "300M"], ["500M", "500M"], ["1G", "1G"]])}</select>
          </span>
        </label>
        <label class="ds-ctl" title="ingest --watch 每轮最多渲染的版本数（越小插队越及时；自动=8）">每批数量
          <span class="sel-wrap">
            <select id="ds-batch" ${batchLocked ? "disabled" : ""}>${opt(this.prefs.batch, [["0", "自动 (8)"], ["4", "4"], ["8", "8"], ["16", "16"], ["32", "32"], ["64", "64"]])}</select>
          </span>
          ${batchLocked ? '<span class="ds-lock muted" title="CLI --batch 已指定，此处不可改">CLI 锁定</span>' : ""}
        </label>
      </div>`;
    if (settingsEl) settingsEl.innerHTML = settings;
    el.innerHTML =
      `<div class="ds-sel-tip muted">正在渲染（勾选以取消渲染）</div>${renderedHtml}` +
      `<div class="ds-sel-tip muted">备选文件夹（勾选以加入渲染）</div>${candHtml}` +
      `<div class="ds-side-btns"><button id="ds-commit" class="${dirty ? "primary" : ""}" ${dirty ? "" : "disabled"}>提交修改${dirty ? `（${this.addSet.size + this.rmSet.size}）` : ""}</button></div>`;
    el.querySelectorAll(".ds-item input").forEach((cb) =>
      cb.addEventListener("change", () => {
        const nm = cb.dataset.name;
        if (cb.dataset.group === "rm") { if (cb.checked) this.rmSet.add(nm); else this.rmSet.delete(nm); }
        else { if (cb.checked) this.addSet.add(nm); else this.addSet.delete(nm); }
        this.renderSidebar();
      }));
    document.getElementById("ds-commit").addEventListener("click", () => this.commit());
    const cl = document.getElementById("ds-cache-limit");
    if (cl) cl.addEventListener("change", (e) => {
      this.prefs.cache_limit = e.target.value;
      this.savePrefs();
    });
    const bt = document.getElementById("ds-batch");
    if (bt) bt.addEventListener("change", (e) => {
      this.prefs.batch = Number(e.target.value) || 0;
      this.savePrefs();
    });
  },

  async render() {
    await this.loadSidebar();
    this.renderSidebar();
    this.syncControls();
    const ds = App.state.datasets || [];
    const decks = App.state.decks || [];
    const hint = await this.backendHint();
    document.getElementById("ds-content").innerHTML =
      (hint ? `<div class="ds-hint">${hint}</div>` : "") +
      (this.axis === "dataset" ? this.datasetTable(ds, decks) : this.deckMatrix(ds, decks));
  },

  /* 检测 ingest 是否在监听本目录：meta/status.json 缺失或 active 非 true →
     提示「不会自动渲染」及启动命令（浏览器拿不到绝对路径，命令以模板展示）。
     active 可能因「上次单次渲染残留 / 工作区 config 未同步」为 false，用桥接区分。 */
  async backendHint() {
    let st = null;
    try { st = await FS.readJSON("meta/status.json"); } catch (_) { /* ignore */ }
    const bridge = FS.bridgeBase() && (await FS.bridgeGetConfig());
    if (!st) {
      return "⚠️ 本目录还没有 meta/status.json —— 用 <code>python scripts/launch.py</code> 启动（本地桥接）后：" +
        "在「数据」页勾选「备选文件夹」并「提交修改」，会嗅探建 config 并同步到工作区跟踪配置，ingest 自动开始渲染。";
    }
    if (st.active !== true) {
      if (bridge) {
        return "⚠️ status.active 仍为 false：ingest 已以 --watch 运行，但尚未处理本目录（工作区 config 未同步？）。" +
          "请点「⇥ 复制到工作区」同步后再试；若仍不变，确认最近一次 ingest 用的是 --watch 而非单次渲染。";
      }
      return "⚠️ 未检测到本地桥接（launch.py）—— 需用 <code>python scripts/launch.py</code> 以 --watch 启动，" +
        "新增 / 修改才会自动增量渲染。";
    }
    return "";
  },

  /* 纵轴=Deck：行=Deck，横轴=各数据源（method…），格内为对应版本状态 */
  deckMatrix(ds, decks) {
    let list = decks.slice();
    if (this.statuses.size) list = list.filter((d) => this.statuses.has(d.status));
    const head = `<tr><th>Deck</th>${ds.map((d) => `<th>${escapeHtml(d.name)}</th>`).join("")}</tr>`;
    const rows = list.map((d) => {
      const cells = ds.map((dsobj) => {
        const v = d.versions.find((x) => x.dataset_id === dsobj.id);
        if (!v) return `<td class="cell">-</td>`;
        const label = v.status === "ready" ? (v.page_count || 0) + "p"
          : v.status === "rendering" ? "渲染中" : v.status === "failed" ? "失败" : "待处理";
        return `<td class="cell vs ${v.status}">${label}</td>`;
      }).join("");
      return `<tr><th>${escapeHtml(d.name)}</th>${cells}</tr>`;
    }).join("");
    return `<div class="ds-scroll"><div class="ds-table-wrap"><table class="ds-matrix"><thead>${head}</thead><tbody>${rows}</tbody></table></div></div>`;
  },

  /* 纵轴=数据源：行=数据源，列为各状态计数 */
  datasetTable(ds, decks) {
    if (!ds.length) return '<div class="empty muted">暂无数据集。请配置 data/config.json 并运行 ingest。</div>';
    const rows = ds.map((d) => {
      const dds = decks.filter((k) => k.versions.some((v) => v.dataset_id === d.id));
      const ready = dds.filter((k) => k.status === "ready").length;
      const rendering = dds.filter((k) => k.status === "rendering").length;
      const pending = dds.filter((k) => k.status === "pending").length;
      const failed = dds.filter((k) => k.status === "failed").length;
      return `<tr><th>${escapeHtml(d.name)}</th><td>${dds.length}</td><td class="ok">${ready}</td><td class="warn">${rendering}</td><td class="muted">${pending}</td><td class="err">${failed}</td></tr>`;
    }).join("");
    return `<div class="ds-scroll"><div class="ds-table-wrap"><table class="ds-matrix"><thead><tr><th>数据源</th><th>Deck 数</th><th>就绪</th><th>渲染中</th><th>待处理</th><th>失败</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  },

  /* ---- 提交修改：一次性写 config.json（增/删渲染组），避免频繁写盘卡顿 ----
     会同步到工作区跟踪配置（经桥接），使 ingest（始终监听工作区 config）也能渲染；
     无 config.json 的外部目录：嗅探勾选后提交即自动建 config + 提示一次 data_dir 绝对路径。 */
  async commit() {
    if (!this.addSet.size && !this.rmSet.size) return;
    try {
      // 提交前确保读写权限（在点击的用户手势内），避免中途 ensureDataDir 弹 prompt 后
      // getFileHandle({create:true}) 因失去用户激活而失败（"User activation is required"）。
      if (FS.ensureWritePermission) await FS.ensureWritePermission();
      const cfg = (await FS.readJSON("config.json")) || { datasets: [] };
      let ds = cfg.datasets || [];
      // 取消渲染：从配置移除（不删物理文件夹）
      if (this.rmSet.size) ds = ds.filter((d) => !this.rmSet.has(d.name));
      // 加入渲染：把备选文件夹写进配置（路径写「相对 data 目录」）
      if (this.addSet.size) {
        let maxOrder = Math.max(-1, ...ds.map((d) => d.sort_order ?? -1));
        const existing = new Set(ds.map((d) => d.name));
        for (const nm of this.addSet) {
          if (existing.has(nm)) continue;
          ds.push({ name: nm, path: this.relPathFor(nm), sort_order: ++maxOrder });
          existing.add(nm);
        }
      }
      cfg.datasets = ds;
      cfg.prefs = Object.assign({}, cfg.prefs || {}, this.prefs);   // 保留渲染设置
      // 无 data_dir（如 config 缺失的外部目录）：绝对路径自动推导，否则请用户填一次
      const dd = await this.ensureDataDir(cfg);
      if (!dd) { alert("已取消：未设置 data_dir，渲染无法定位外部目录。"); this.render(); return; }
      await FS.writeJSONAtomic("config.json", cfg);   // 写回被打开目录（自描述，下次免填）
      this.addSet.clear();
      this.rmSet.clear();
      await this.render();   // 重扫候选（已渲染的组不再出现在备选）+ 重绘
      const okBridge = await FS.bridgePutConfig(cfg);  // 同步到工作区跟踪配置 → ingest 渲染
      App._pollDelay = 1000;
      App.poll();
      alert(okBridge
        ? "已提交：config 已写入本目录并同步到工作区跟踪配置，ingest 会自动开始渲染（输出到 data_dir）。"
        : "已写入本目录 config.json，但未检测到本地桥接，无法触发 ingest 渲染。请用 python scripts/launch.py 启动。");
    } catch (e) { alert("提交失败：" + e.message); }
  },

  /* 保存渲染设置（缓存上限 / 每批数量）到 config prefs，并同步到工作区跟踪配置 */
  async savePrefs() {
    try {
      if (FS.ensureWritePermission) await FS.ensureWritePermission();
      const cfg = (await FS.readJSON("config.json")) || { datasets: [], prefs: {} };
      cfg.prefs = Object.assign({}, cfg.prefs || {}, this.prefs);
      this.cfg = cfg;
      await FS.writeJSONAtomic("config.json", cfg);
      const okBridge = await FS.bridgePutConfig(cfg);
      OpLog.add("保存渲染设置（缓存/每批）" + (okBridge ? "" : "（未同步到工作区）"));
    } catch (e) { alert("保存设置失败：" + e.message); }
  },

  /* 确保 config 有 data_dir：有则保留；数据集为绝对路径时自动推导公共前缀；
     否则提示用户输入一次本 data 目录的绝对路径（浏览器隐私拿不到路径）。返回 data_dir 或 null。 */
  async ensureDataDir(cfg) {
    if (cfg.data_dir) return cfg.data_dir;
    const ds = cfg.datasets || [];
    const norm = ds.map((d) => d.path).filter((p) => p != null && p !== "");
    const isAbs = (p) => /^([A-Za-z]:\/|\/)/.test(p);
    if (norm.length && norm.length === ds.length && norm.every(isAbs)) {
      const root = deriveDataRoot(norm);
      if (root) { cfg.data_dir = root; return root; }
    }
    const p = prompt("该 data 目录没有 config.json / data_dir。\n请输入本目录的绝对路径（用于定位源文件与渲染输出）：", "");
    if (!p) return null;
    cfg.data_dir = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return cfg.data_dir;
  },

  /* 加入渲染的数据源路径：写「相对 data 目录」的路径（跨环境可迁移），
     ingest 以配置文件所在目录（即所选 data 目录）解析相对路径。 */
  relPathFor(nm) {
    const c = this.candMap && this.candMap[nm];
    return (c && c.rel) || nm;
  },

  /* 增量扫描目录：外部拖入新文件夹后点「目录 ⟳ 刷新」；
     清全树扫描缓存强制重扫，保留当前勾选（addSet/rmSet 不清）。 */
  async refreshCandidates() {
    _srcDirsCache = null;   // 强制增量重扫
    await this.loadSidebar();
    this.renderSidebar();
    OpLog.add("增量扫描备选文件夹");
  },

  /* 把一份 config 复制到工作区 config（经本地桥接）；尽量推导 data_dir，使渲染输出落到外部目录。
     返回是否成功。 */
  async copyToWorkspace(localCfg) {
    const cfg = JSON.parse(JSON.stringify(localCfg || {}));
    const ds = cfg.datasets || [];
    const paths = ds.map((d) => d.path).filter((p) => p != null && p !== "");
    const isAbs = (p) => /^([A-Za-z]:\/|\/)/.test(p);
    if (paths.length && paths.length === ds.length && paths.every(isAbs)) {
      const root = deriveDataRoot(paths);
      if (root) {
        cfg.data_dir = root;
        ds.forEach((d) => { const rp = stripDataRoot(d.path, root); if (rp) d.path = rp; });
      }
    }
    const ok = await FS.bridgePutConfig(cfg);
    if (ok) OpLog.add("复制 config → 工作区" + (cfg.data_dir ? "（data_dir 重定向）" : ""));
    return ok;
  },

  /* 「⇥ 复制到工作区」：把当前打开的 data 目录的 config 复制到工作区 config（ingest 始终监听它） */
  async importToWorkspace() {
    const local = await FS.readJSON("config.json");
    if (!local || !Array.isArray(local.datasets)) {
      alert("当前 data 目录没有 config.json，无法复制。");
      return;
    }
    const ds = local.datasets || [];
    const relNoAnchor = !local.data_dir &&
      ds.some((d) => d.path && !/^([A-Za-z]:[\\/]|\/)/.test(d.path));
    const ok = await this.copyToWorkspace(local);
    if (ok) {
      let msg = "已把当前目录的 config 复制到工作区跟踪配置（ingest 监听它）。\n" +
                "ingest 检测到变化后会自动开始渲染（输出到 data_dir 指向的目录）。";
      if (relNoAnchor) {
        msg += "\n\n⚠️ 提示：该 config 用相对路径且无 data_dir，ingest 会以工作区 watched/ 为基准解析，" +
               "可能找不到源。建议在 config.json 里加一行 \"data_dir\": \"<该目录绝对路径>\"。";
      }
      alert(msg);
      App._pollDelay = 1000;
      App.poll();
    } else {
      alert("未检测到本地桥接（需用 python scripts/launch.py 启动，前端带 ?bridge=端口）。");
    }
  },

  /* 「⇤ 写回目录」：把工作区 config 复制回当前打开的 data 目录的 config.json */
  async exportToDir() {
    const cfg = await FS.bridgeGetConfig();
    if (!cfg) {
      alert("未检测到本地桥接（需用 python scripts/launch.py 启动）。");
      return;
    }
    await FS.writeJSONAtomic("config.json", cfg);
    OpLog.add("工作区 config → 写回当前目录");
    alert("已把工作区 config 写回当前 data 目录的 config.json。");
  },

  /* 同步控制条：纵轴下拉值 + 状态多选勾选/按钮文案 */
  syncControls() {
    const axisSel = document.getElementById("ds-axis");
    if (axisSel) axisSel.value = this.axis;
    const ms = document.getElementById("ds-status-ms");
    if (!ms) return;
    ms.querySelectorAll("input[data-st]").forEach((cb) => {
      cb.checked = cb.dataset.st === "all"
        ? this.statuses.size === 0
        : this.statuses.has(cb.dataset.st);
    });
    const btn = document.getElementById("ds-status-btn");
    if (btn) {
      btn.textContent = this.statuses.size
        ? "状态：" + [...this.statuses].map((s) => DS_LABEL[s] || s).join("、")
        : "状态：全部";
    }
  },

  setAxis(a) { this.axis = a; this.syncControls(); this.render(); },

  onStatusToggle(cb) {
    const st = cb.dataset.st;
    if (st === "all") {
      if (cb.checked) { this.statuses.clear(); this.render(); }
      return;
    }
    if (cb.checked) this.statuses.add(st); else this.statuses.delete(st);
    this.render();   // 空集合 = 全部；syncControls 会把「全部」重新勾上
  },

  async refresh() {
    // 添加数据源/手动改 config 后：重新拉取 manifest 与标注并重绘
    await App.refreshManifest();
    await App.refreshAnnotations();
    this.render();
    OpLog.add("刷新数据页");
  },

  bind() {
    document.getElementById("ds-axis").addEventListener("change", (e) => this.setAxis(e.target.value));
    document.querySelectorAll("#ds-status-ms input[data-st]").forEach((cb) =>
      cb.addEventListener("change", () => this.onStatusToggle(cb)));
    document.getElementById("ds-status-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const p = document.getElementById("ds-status-ms").querySelector(".ms-panel");
      if (p) p.hidden = !p.hidden;
    });
    document.addEventListener("click", (e) => {
      const ms = document.getElementById("ds-status-ms");
      if (ms && !ms.contains(e.target)) {
        const p = ms.querySelector(".ms-panel");
        if (p) p.hidden = true;
      }
    });
    document.getElementById("ds-refresh").addEventListener("click", () => this.refresh());
    document.getElementById("ds-dir-refresh").addEventListener("click", () => this.refreshCandidates());
    document.getElementById("ds-import").addEventListener("click", () => this.importToWorkspace());
    document.getElementById("ds-export").addEventListener("click", () => this.exportToDir());
  },
};

const App = {
  state: {
    status: null,
    datasets: [],
    decks: [],
    annotations: {},
    savedAnnotations: {},
    prefs: { shuffle: false, sync_page: true, cols: 4, overlap: false, auto: false },
    view: "explorer",
    currentDeckId: null,
    dirInfo: null,
  },
  _pollDelay: 2000,
  _pollTimer: null,

  async init() {
    this.bindUI();
    this.loadPrefs();
    this.setView("explorer");
    if (!FS.hasSupport()) {
      this.showError("当前浏览器不支持 File System Access API，请使用 Chromium / Edge 打开本页。");
      return;
    }
    try {
      const h = await FS.tryRestore();
      if (h) {
        this.hideOverlay();
        try {
          await this.loadAll();
          this.route();
          if (!this.state.currentDeckId) this.openFirstReady();
          this.poll();
        } catch (e) {
          // 目录读取失败（句柄失效 / 权限被重置 / 路径不对）→ 弹出重新授权的选择窗格
          this.showOverlay();
          document.getElementById("sb-annot").textContent =
            "目录读取失败，请重新选择 data 目录";
          this.updateStatusBar();
        }
      } else {
        this.showOverlay();  // 仅在未保存过路径时弹选择框
      }
    } catch (_) {
      this.showOverlay();
    }
  },

  bindUI() {
    document.getElementById("btn-pick-dir").addEventListener("click", async () => {
      try {
        await FS.getHandle();
        _srcDirsCache = null;   // 新目录 → 清扫描缓存
        this.hideOverlay();
        await this.loadAll();
        this.autoImportIfNeeded();   // 工作区 config 为空时自动复制当前目录 config
        this.route();
        if (!this.state.currentDeckId) this.openFirstReady();
        this.poll();
      } catch (e) { this.showError("选择目录失败：" + e.message); }
    });
    document.getElementById("btn-open-dir").addEventListener("click", async () => {
      try {
        if (Annotate && Annotate.flush) Annotate.flush();   // 先保存到旧目录
        const h = await FS.reSelect();
        if (!h) return;   // 取消：保留原目录与原界面（评分历史等），不弹错误
        _srcDirsCache = null;   // 新目录 → 清扫描缓存
        // 选择不同目录 → 清理旧目录相关的本地选项/日志/标注
        try {
          localStorage.removeItem("ppt.prefs");
          localStorage.removeItem("ppt.sidebarWidth");
          OpLog.clear();
        } catch (_) { /* ignore */ }
        this.state.prefs = { shuffle: false, sync_page: true, cols: 4, overlap: false, auto: false };
        this.state.annotations = {};
        this.state.savedAnnotations = {};
        this.state.currentDeckId = null;
        Annotate.close();
        document.getElementById("quick-open").value = "";
        await this.loadAll();
        this.autoImportIfNeeded();   // 工作区 config 为空时自动复制当前目录 config
        this.setView("explorer");
        this.route();
        if (!this.state.currentDeckId) this.openFirstReady();
        this.updateStatusBar();
        document.getElementById("sb-annot").textContent = "已重新选择 data 目录";
        OpLog.add("选择新目录");
      } catch (e) { this.showError("重选目录失败：" + e.message); }
    });
    // 点击底部状态栏「目录：xxx」chip 同样可重选目录（复用标题栏 data 目录按钮）
    document.getElementById("sb-fs").addEventListener("click", () =>
      document.getElementById("btn-open-dir").click());
    document.getElementById("btn-export").addEventListener("click", () => this.exportAnnotations());
    document.getElementById("btn-import").addEventListener("click", () => this.importAnnotations());
    document.querySelectorAll("#activitybar button").forEach((b) =>
      b.addEventListener("click", () => this.setView(b.dataset.view)));
    document.getElementById("quick-open").addEventListener("input", (e) => Explorer.applyFilter(e.target.value));
    document.getElementById("deck-filter").addEventListener("change", (e) => Explorer.setStatusFilter(e.target.value));
    document.getElementById("quick-open").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const d = Explorer.firstMatch(); if (d && d.status === "ready") this.openDeck(d.id, { noShuffle: true }); }
    });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        document.getElementById("quick-open").focus();
      }
    });
    Annotate.bind();
    Datasets.bind();
    // 报告顶部工具栏（静态按钮，只绑定一次；report.js 每次切页都会重绘正文，不能在 render 里重复绑定，
    // 否则监听器累积 → 点一次「导出 HTML」会下载多份）。
    const repRefresh = document.getElementById("rep-refresh");
    if (repRefresh) repRefresh.addEventListener("click", async () => {
      await this.refreshManifest();
      await this.refreshAnnotations();
      Report.render();
    });
    const repExport = document.getElementById("rep-export");
    if (repExport) repExport.addEventListener("click", () => Report.exportHTML());
    this.bindSplitter();

    // 清空菜单：清空当前 Deck 或全部 Deck 的标注与历史
    const clearBtn = document.getElementById("btn-clear");
    const clearMenu = document.getElementById("clear-menu");
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearMenu.hidden = !clearMenu.hidden;
    });
    clearMenu.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      clearMenu.hidden = true;
      if (b.dataset.scope === "current") {
        if (!Annotate.hasDeck()) return;
        if (!window.confirm("确定清空当前 Deck 的标注与历史？")) return;
        await this.clearAnnotations(Annotate.currentDeckId());
        Annotate.resetCurrent();
      } else {
        if (!window.confirm("确定清空全部 Deck 的标注与历史？")) return;
        await this.clearAnnotations(null);
        Annotate.resetCurrent();
      }
    });
    document.addEventListener("click", () => { clearMenu.hidden = true; });

    // 有未保存改动时，关闭页面给出提示
    window.addEventListener("beforeunload", (e) => {
      if (Annotate && Annotate.hasDirty && Annotate.hasDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { this._pollDelay = 1000; this.poll(); }
    });
  },

  loadPrefs() {
    try {
      this.state.prefs = Object.assign(this.state.prefs,
        JSON.parse(localStorage.getItem("ppt.prefs") || "{}"));
    } catch (_) { /* ignore */ }
  },
  savePrefs() {
    localStorage.setItem("ppt.prefs", JSON.stringify(this.state.prefs));
  },

  /* 拖动分隔条调整目录(侧栏)宽度，持久化到 localStorage */
  bindSplitter() {
    const sb = document.getElementById("sidebar");
    const sp = document.getElementById("splitter");
    if (!sb || !sp) return;
    const saved = Number(localStorage.getItem("ppt.sidebarWidth"));
    if (saved >= 150) sb.style.width = saved + "px";
    sp.addEventListener("mousedown", (e) => {
      e.preventDefault();
      sp.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (ev) => {
        const sbLeft = sb.getBoundingClientRect().left;
        const spW = sp.getBoundingClientRect().width;
        const w = Math.round(Math.min(Math.max(ev.clientX - sbLeft - spW / 2, 150), Math.floor(window.innerWidth * 0.4)));
        sb.style.width = w + "px";
        // 侧栏变宽 → 右侧卡片流按新宽度拉伸/压缩重排
        if (Annotate && Annotate.onViewportResize) Annotate.onViewportResize();
      };
      const up = () => {
        sp.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        localStorage.setItem("ppt.sidebarWidth", String(sb.getBoundingClientRect().width));
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  },

  async loadAll() {
    await this.refreshManifest();
    await this.refreshAnnotations();
  },

  /* 打开/重选目录后：若本地桥接可用且工作区 config 为空，自动把当前目录 config 复制过去
     （ingest 始终监听工作区 config） */
  async autoImportIfNeeded() {
    if (!FS.bridgeBase()) return;
    try {
      const wcfg = await FS.bridgeGetConfig();
      if (wcfg && (wcfg.datasets || []).length) return;   // 工作区已有配置，不覆盖
      const lcfg = await FS.readJSON("config.json");
      if (lcfg && (lcfg.datasets || []).length) await Datasets.copyToWorkspace(lcfg);
    } catch (_) { /* ignore */ }
  },

  async refreshManifest() {
    const m = await FS.readJSON("meta/manifest.json");
    this.state.dirInfo = await FS.dirInfo();
    const di = this.state.dirInfo || {};
    if (!m) {
      this.state.datasets = [];
      this.state.decks = [];
      document.getElementById("sb-annot").textContent = di.hasConfig
        ? "未找到 meta/manifest.json —— config 已存在；确认 ingest 在监听并稍候，或点数据页「⟳ 刷新」"
        : "未找到 config.json/meta —— 打开任意含 pptx 的目录，在「数据」页会自动嗅探备选文件夹，勾选并「提交修改」即开始渲染";
    } else {
      this.state.datasets = m.datasets || [];
      this.state.decks = m.decks || [];
    }
    this.updateFsStatus();
    Explorer.render();
  },

  /* 状态栏：显示当前选中的目录名 + 是否含 meta/manifest.json。
     浏览器隐私限制拿不到绝对路径，只能拿目录名；顶层条目放在 title 悬停提示里。 */
  updateFsStatus() {
    const d = this.state.dirInfo || { name: "", hasMeta: false, top: [] };
    const el = document.getElementById("sb-fs");
    if (!d.name) { el.textContent = "未选择 data 目录"; el.title = ""; return; }
    el.textContent = d.hasMeta
      ? `目录: ${d.name} ✓ (含 meta/manifest.json)`
      : `目录: ${d.name} ✗ 未找到 meta/manifest.json`;
    el.title = "顶层条目: " + (d.top.length ? d.top.join(", ") : "（空目录）");
  },

  async refreshAnnotations() {
    const a = await FS.readJSON("annotations.json");
    this.state.annotations = a || {};
    this.state.savedAnnotations = JSON.parse(JSON.stringify(this.state.annotations));
  },

  async poll() {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    const status = await FS.readJSON("meta/status.json");
    if (status) {
      const changed = !this.state.status || status.version !== this.state.status.version;
      this.state.status = status;
      if (changed) {
        await this.refreshManifest();
        await this.refreshAnnotations();
        this.syncOpenDeck();
        if (this.state.view === "datasets") Datasets.render();   // 数据页实时刷新后端提示 / 每批锁定
      }
    }
    this.updateStatusBar();
    // status.json 是小文件：固定 1s 轮询，及时反映渲染完成 / 数据源数量变化。
    // 后端已保证「无变化不写盘」，version 稳定时不会重复重读 manifest。
    const delay = document.hidden ? 60000 : 1000;   // 标签页隐藏暂停轮询
    this._pollTimer = setTimeout(() => this.poll(), delay);
  },

  /* ---------- 视图与路由 ---------- */
  setView(view) {
    const prev = this.state.view;   // 记录上一个视图，判断是否为「切到标注页」
    this.state.view = view;
    document.querySelectorAll("#activitybar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("sidebar-title").textContent =
      view === "datasets" ? "数据集" : view === "explorer" ? "Deck 列表" : "报告";
    document.getElementById("deck-list").hidden = view !== "explorer";
    document.getElementById("deck-filter-row").hidden = view !== "explorer";
    document.getElementById("sidebar-count").hidden = view !== "explorer";   // 计数只在标注页显示
    document.getElementById("dataset-list").hidden = view !== "datasets";
    // 报告视图：隐藏左侧整个灰色目录栏（含分隔条），报告区全宽
    document.getElementById("sidebar").hidden = view === "report";
    document.getElementById("splitter").hidden = view === "report";
    document.getElementById("annotate").hidden = view !== "explorer";
    document.getElementById("datasets").hidden = view !== "datasets";
    document.getElementById("report").hidden = view !== "report";
    document.getElementById("empty-state").hidden = true;
    if (view === "datasets") Datasets.render();
    if (view === "report") {
      // 先落盘当前草稿（异步）再渲染报告：避免把「仅内存、未保存」的草稿误计为已标注
      const flushP = (Annotate && Annotate.flush) ? Annotate.flush() : Promise.resolve();
      Promise.resolve(flushP).then(() => Report.render());
    }
    if (view === "explorer") {
      document.getElementById("empty-state").hidden =
        this.state.decks.some((d) => d.status === "ready");
      // 从其它页面切到标注页：重读 manifest 并同步当前 Deck（版本数变化→重建框格），
      // 再按框体大小重判原图/缩略图；并加快轮询，尽快反映 ingest 的最新渲染/数据源数量。
      // 本就停留在标注页：什么都不做，避免重复刷新。
      if (prev !== "explorer") {
        this._pollDelay = 1000;
        this.poll();
        this.refreshManifest().then(() => {
          this.syncOpenDeck();
          if (Annotate && Annotate.onShown) Annotate.onShown();
        });
      }
    }
  },

  route() {
    const m = location.hash.match(/^#\/deck\/(\d+)$/);
    if (m) this.openDeck(Number(m[1]));
    else this.setView("explorer");
  },

  deckById(id) { return this.state.decks.find((d) => d.id === id) || null; },

  /* manifest 变化后同步当前打开的 Deck：版本数变化重建卡片；Deck 消失→清空画布；重现→自动重开 */
  syncOpenDeck() {
    const id = this.state.currentDeckId;
    if (id == null) return;
    const deck = this.deckById(id);
    if (deck) {
      Annotate.refreshStatus(deck);
      if (!Annotate.hasDeck() && this.state.view === "explorer") {
        this.openDeck(id, { allowPending: true });   // 数据源回到 ≥1 个时重新打开：先空框、渲染好再填充
      }
    } else if (Annotate.hasDeck()) {
      Annotate.close();                              // 数据源全取消 → 画布清空（什么都不显示）
      // 清掉左下角“渲染中，请稍候…”等旧提示与旧 Deck 名
      document.getElementById("sb-annot").textContent = "";
      document.getElementById("sb-deck").textContent = "";
    }
  },

  openFirstReady() {
    const d = this.state.decks.find((x) => x.status === "ready");
    if (d) this.openDeck(d.id);
  },

  openDeck(id, opts) {
    const deck = this.deckById(id);
    if (!deck) return;
    const evicted = deck.evicted === true ||
      (!!deck.versions && deck.versions.length > 0 && deck.versions.every((v) => v.evicted));
    if (deck.status !== "ready") {
      // 未就绪：照样选中并打开（先显示占位框），请求插队渲染；就绪后轮询自动填图
      document.getElementById("sb-annot").textContent =
        deck.name + (evicted ? " 缓存已清理，正在优先重渲…" : " 渲染中…就绪后自动显示图片");
      this.requestPriority(deck.id);
    } else {
      this.clearPriority(id);   // 已就绪打开 → 从优先级移除
    }
    this.state.currentDeckId = id;
    location.hash = "#/deck/" + id;
    this.markCurrentDeck(id);   // 记录当前查看 Deck（缓存清理保护：轮到它时先休息）
    this.setView("explorer");
    document.getElementById("empty-state").hidden = true;
    Annotate.openDeck(deck, opts);
    Explorer.render();   // 刷新列表高亮与完成标记（✓/●）
    OpLog.add("打开 Deck " + deck.name);
  },

  /* ---------- 插队渲染：请求 / 清除某 Deck 的优先渲染（写 data/priority.json） ----------
     用户跳过一些 Deck 到某 Deck 处等待时，ingest --watch 每批都会读这个文件，
     把对应 Deck 排到最前渲染。写失败只是尽力而为，不影响正常使用。 */
  async requestPriority(deckId) {
    try {
      if (FS.ensureWritePermission) await FS.ensureWritePermission();
      const cur = (await FS.readJSON("priority.json")) || {};
      const ids = new Set(Array.isArray(cur.deck_ids) ? cur.deck_ids.map(Number) : []);
      if (ids.has(Number(deckId))) return;   // 已在队列，不重复写盘
      ids.add(Number(deckId));
      await FS.writeJSONAtomic("priority.json",
        { deck_ids: [...ids], updated_at: new Date().toISOString() });
      OpLog.add("请求优先渲染 Deck " + deckId);
    } catch (_) { /* ignore */ }
  },

  /* 该 Deck 已就绪并打开后，从优先级中移除（避免 stale 条目堆积；无变化不写盘） */
  async clearPriority(deckId) {
    try {
      const cur = (await FS.readJSON("priority.json")) || {};
      const had = Array.isArray(cur.deck_ids) ? cur.deck_ids : [];
      const ids = had.filter((i) => Number(i) !== Number(deckId));
      if (ids.length === had.length) return;
      await FS.writeJSONAtomic("priority.json",
        { deck_ids: ids, updated_at: new Date().toISOString() });
    } catch (_) { /* ignore */ }
  },

  /* 记录当前查看的 Deck（data/current.json）——缓存清理「休息」保护据此判断（轮到你时先不清） */
  async markCurrentDeck(deckId) {
    try {
      if (FS.ensureWritePermission) await FS.ensureWritePermission();
      await FS.writeJSONAtomic("current.json",
        { deck_id: Number(deckId), updated_at: new Date().toISOString() });
    } catch (_) { /* 尽力而为 */ }
  },

  stepDeck(delta) {
    const ids = this.state.decks.filter((d) => d.status === "ready").map((d) => d.id);
    if (!ids.length) return;
    const i = ids.indexOf(this.state.currentDeckId);
    const next = ids[(i + delta + ids.length) % ids.length];
    this.openDeck(next);
  },

  /* ---------- 标注保存（先写历史，再原子覆盖；以已存快照做差异） ---------- */
  async saveAnnotation(deckId, next) {
    const prev = this.state.savedAnnotations[deckId] || null;
    if (prev && !sameAnno(prev, next)) {   // 内容实质变化才记历史（忽略时间戳）
      await FS.appendLine("annotations_history.jsonl",
        JSON.stringify({ deck_id: Number(deckId), ts: new Date().toISOString(), prev }));
    }
    this.state.annotations[deckId] = next;
    this.state.savedAnnotations[deckId] = next;
    await FS.writeJSONAtomic("annotations.json", this.state.savedAnnotations);
    Explorer.render();
  },

  /* 清空某个 Deck（deckId）或全部（null）的标注与历史 */
  async clearAnnotations(deckId) {
    if (deckId === null) { this.state.annotations = {}; this.state.savedAnnotations = {}; }
    else { delete this.state.annotations[deckId]; delete this.state.savedAnnotations[deckId]; }
    let hist = "";
    try { hist = await FS.readFileText("annotations_history.jsonl"); } catch (_) { /* 无历史文件 */ }
    let newHist = "";
    if (hist) {
      newHist = hist.split("\n").filter((l) => {
        if (!l.trim()) return false;
        if (deckId === null) return false;
        try { return JSON.parse(l).deck_id !== Number(deckId); } catch (_) { return true; }
      }).join("\n");
      if (newHist) newHist += "\n";
    }
    await FS.writeJSONAtomic("annotations.json", this.state.savedAnnotations);
    await FS.writeJSONAtomic("annotations_history.jsonl", newHist);
    Explorer.render();
    OpLog.add(deckId === null ? "清空全部 Deck" : "清空 Deck " + deckId);
  },

  exportAnnotations() {
    const blob = new Blob([JSON.stringify(this.state.annotations, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "annotations.json";
    a.click();
    URL.revokeObjectURL(a.href);
  },

  importAnnotations() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        this.state.annotations = data || {};
        await FS.writeJSONAtomic("annotations.json", this.state.annotations);
        Explorer.render();
      } catch (e) {
        document.getElementById("sb-annot").textContent = "导入失败：" + e.message;
      }
    };
    input.click();
  },

  /* ---------- 状态栏 ---------- */
  updateStatusBar() {
    const st = this.state.status || {};
    document.getElementById("sb-progress").textContent =
      `Deck ${st.ready || 0}/${st.total || 0} 已就绪` +
      (st.rendering ? ` · 渲染中 ${st.rendering}` : "") +
      (st.failed ? ` · 失败 ${st.failed}` : "");
    this.updateFsStatus();
  },
  statusBarDeck(deck) {
    document.getElementById("sb-deck").textContent = deck ? deck.name : "";
  },

  /* ---------- 覆盖层 ---------- */
  showError(msg) {
    const err = document.getElementById("overlay-error");
    err.hidden = false;
    err.textContent = msg;
    document.getElementById("overlay").hidden = false;
  },
  showOverlay() {
    const err = document.getElementById("overlay-error");
    err.hidden = true;
    err.textContent = "";
    document.getElementById("overlay").hidden = false;
  },
  hideOverlay() {
    document.getElementById("overlay").hidden = true;
  },
};

App.init();
