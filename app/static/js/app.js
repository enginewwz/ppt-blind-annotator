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
  candidates: [],       // 备选文件夹名（容器内未在渲染的）
  addSet: new Set(),    // 勾选要加入渲染的备选
  rmSet: new Set(),     // 勾选要取消渲染的现有组

  async loadSidebar() {
    let cfg = null;
    try { cfg = await FS.readJSON("config.json"); } catch (_) { /* ignore */ }
    this.cfg = cfg || { datasets: [] };
    this.rendered = (this.cfg.datasets || []).map((d) => d.name);
    this.candidates = [];
    const cfgDs = this.cfg.datasets || [];
    if (cfgDs.length) {
      try {
        const relFirst = await findDirRel(cfgDs[0].name);
        if (relFirst) {
          const relContainer = relFirst.split("/").slice(0, -1).join("/");
          const entries = await FS.listDir(relContainer);
          this.candidates = entries.filter((e) => e.kind === "directory").map((e) => e.name)
            .filter((n) => !this.rendered.includes(n));
        }
      } catch (_) { /* ignore */ }
    }
  },

  async renderSidebar() {
    const el = document.getElementById("dataset-list");
    await this.loadSidebar();
    const item = (group, nm, checked, extra) =>
      `<label class="ds-item ${extra}">
        <input type="checkbox" data-group="${group}" data-name="${escapeHtml(nm)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(nm)}</span>
      </label>`;
    const renderedHtml = this.rendered.map((n) =>
      item("rm", n, this.rmSet.has(n), this.rmSet.has(n) ? "rm" : "")).join("") ||
      '<div class="empty muted">（暂无渲染中的组）</div>';
    const candHtml = this.candidates.map((n) =>
      item("add", n, this.addSet.has(n), this.addSet.has(n) ? "add" : "")).join("") ||
      '<div class="empty muted">（无备选文件夹）</div>';
    const dirty = this.addSet.size + this.rmSet.size > 0;
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
  },

  async render() {
    this.renderSidebar();
    this.syncControls();
    const ds = App.state.datasets || [];
    const decks = App.state.decks || [];
    document.getElementById("ds-content").innerHTML =
      this.axis === "dataset" ? this.datasetTable(ds, decks) : this.deckMatrix(ds, decks);
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

  /* ---- 提交修改：一次性写 config.json（增/删渲染组），避免频繁写盘卡顿 ---- */
  async commit() {
    if (!this.addSet.size && !this.rmSet.size) return;
    try {
      const cfg = (await FS.readJSON("config.json")) || { datasets: [] };
      let ds = cfg.datasets || [];
      // 取消渲染：从配置移除（不删物理文件夹）
      if (this.rmSet.size) ds = ds.filter((d) => !this.rmSet.has(d.name));
      // 加入渲染：把备选文件夹写进配置
      if (this.addSet.size) {
        const allPaths = (cfg.datasets || []).map((d) => d.path);
        const parentAbs = absCommonPrefix(allPaths);
        let maxOrder = Math.max(-1, ...ds.map((d) => d.sort_order ?? -1));
        const existing = new Set(ds.map((d) => d.name));
        for (const nm of this.addSet) {
          if (existing.has(nm)) continue;
          ds.push({ name: nm, path: (parentAbs || "") + "/" + nm, sort_order: ++maxOrder });
          existing.add(nm);
        }
      }
      cfg.datasets = ds;
      await FS.writeJSONAtomic("config.json", cfg);
      this.addSet.clear();
      this.rmSet.clear();
      await this.renderSidebar();
      this.render();
      alert("已提交修改并写入 config.json。\n（若 ingest 以 --watch 运行，会自动开始/停止对应组的渲染；否则请运行 python -m scripts.ingest --watch）");
    } catch (e) { alert("提交失败：" + e.message); }
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
          document.getElementById("sb-annot").textContent =
            "目录读取失败，请点右上角「data 目录」重新授权";
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
        this.hideOverlay();
        await this.loadAll();
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
        this.setView("explorer");
        this.route();
        if (!this.state.currentDeckId) this.openFirstReady();
        this.updateStatusBar();
        document.getElementById("sb-annot").textContent = "已重新选择 data 目录";
        OpLog.add("选择新目录");
      } catch (e) { this.showError("重选目录失败：" + e.message); }
    });
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

  /* index.html 位于 app/static/，manifest 内为项目根相对路径 */
  imgSrc(rel) { return "../../" + rel; },

  async loadAll() {
    await this.refreshManifest();
    await this.refreshAnnotations();
  },

  async refreshManifest() {
    const m = await FS.readJSON("meta/manifest.json");
    if (!m) {
      this.state.datasets = [];
      this.state.decks = [];
      document.getElementById("sb-annot").textContent =
        "未找到 meta/manifest.json —— 请点右上角「data 目录」选择项目的 data/ 目录";
    } else {
      this.state.datasets = m.datasets || [];
      this.state.decks = m.decks || [];
    }
    this.state.dirInfo = await FS.dirInfo();
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
      : `目录: ${d.name} ✗ 选错了，应选项目的 data/ 目录`;
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
        if (this.state.currentDeckId) {
          const d = this.deckById(this.state.currentDeckId);
          if (d) Annotate.refreshStatus(d);
        }
      }
    }
    this.updateStatusBar();
    const st = this.state.status || { rendering: 0 };
    let delay;
    if (document.hidden) delay = 60000;                                   // 隐藏暂停
    else if (st.rendering > 0) { delay = 1000; this._pollDelay = 1000; }  // 有渲染任务：快
    else { this._pollDelay = Math.min(this._pollDelay * 2, 30000); delay = this._pollDelay; }  // 空闲退避
    this._pollTimer = setTimeout(() => this.poll(), delay);
  },

  /* ---------- 视图与路由 ---------- */
  setView(view) {
    this.state.view = view;
    document.querySelectorAll("#activitybar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === view));
    document.getElementById("sidebar-title").textContent =
      view === "datasets" ? "数据集" : view === "explorer" ? "Deck 列表" : "报告";
    document.getElementById("deck-list").hidden = view !== "explorer";
    document.getElementById("deck-filter-row").hidden = view !== "explorer";
    document.getElementById("dataset-list").hidden = view !== "datasets";
    document.getElementById("annotate").hidden = view !== "explorer";
    document.getElementById("datasets").hidden = view !== "datasets";
    document.getElementById("report").hidden = view !== "report";
    document.getElementById("empty-state").hidden = true;
    if (view === "datasets") Datasets.render();
    if (view === "report") Report.render();
    if (view === "explorer") {
      document.getElementById("empty-state").hidden =
        this.state.decks.some((d) => d.status === "ready");
      if (Annotate && Annotate.onShown) Annotate.onShown();   // 切回标注页：按框体大小重判原图/缩略图
    }
  },

  route() {
    const m = location.hash.match(/^#\/deck\/(\d+)$/);
    if (m) this.openDeck(Number(m[1]));
    else this.setView("explorer");
  },

  deckById(id) { return this.state.decks.find((d) => d.id === id) || null; },

  openFirstReady() {
    const d = this.state.decks.find((x) => x.status === "ready");
    if (d) this.openDeck(d.id);
  },

  openDeck(id, opts) {
    const deck = this.deckById(id);
    if (!deck) return;
    if (deck.status !== "ready") {
      document.getElementById("sb-annot").textContent = deck.name + " 尚未就绪（渲染中）";
      return;
    }
    this.state.currentDeckId = id;
    location.hash = "#/deck/" + id;
    this.setView("explorer");
    document.getElementById("empty-state").hidden = true;
    Annotate.openDeck(deck, opts);
    Explorer.render();   // 刷新列表高亮与完成标记（✓/●）
    OpLog.add("打开 Deck " + deck.name);
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
    if (prev && JSON.stringify(prev) !== JSON.stringify(next)) {
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
