/* 应用主入口：初始化、路由、数据加载、动态轮询、标注保存/导入导出。 */

/* 分段选择器：让 #segId 里 data[key]===val 的按钮高亮 */
function segSelect(segId, key, val) {
  document.querySelectorAll(`#${segId} button`).forEach((b) =>
    b.classList.toggle("on", b.dataset[key] === val));
}

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

/* 数据页左侧：真实的目录树（可展开/收纳，含 config 等文件） */
const FolderTree = {
  async render(el) {
    let entries;
    try { entries = await FS.listDir(""); }
    catch (_) { el.innerHTML = '<div class="empty muted">无法读取目录</div>'; return; }
    el.innerHTML = entries.map((e) => this.row(e, "")).join("");
    el.onclick = (ev) => {
      const row = ev.target.closest(".tree-dir");
      if (!row) return;
      const node = row.parentElement;
      const kids = node.querySelector(":scope > .tree-children");
      const arrow = row.querySelector(".tree-arrow");
      if (!kids) return;
      if (kids.dataset.loaded) {
        kids.hidden = !kids.hidden;
        arrow.textContent = kids.hidden ? "▸" : "▾";
        return;
      }
      const path = row.dataset.path;
      arrow.textContent = "…";
      FS.listDir(path).then((es) => {
        kids.innerHTML = es.map((e) => this.row(e, path)).join("");
        kids.dataset.loaded = "1";
        kids.hidden = false;
        arrow.textContent = "▾";
      }).catch(() => { arrow.textContent = "▸"; });
    };
  },
  row(e, parent) {
    const full = parent ? parent + "/" + e.name : e.name;
    if (e.kind === "directory") {
      return `<div class="tree-node">
        <div class="tree-row tree-dir" data-path="${escapeHtml(full)}">
          <span class="tree-arrow">▸</span><span class="tree-name">${escapeHtml(e.name)}</span>
        </div>
        <div class="tree-children" hidden></div>
      </div>`;
    }
    return `<div class="tree-row tree-file">
      <span class="tree-arrow"></span><span class="tree-name">${escapeHtml(e.name)}</span>
    </div>`;
  },
};

const Datasets = {
  filter: "all",       // all | ready | rendering | pending | failed
  view: "deck",        // deck | dataset

  async renderSidebar() {
    FolderTree.render(document.getElementById("dataset-list"));
  },

  async render() {
    this.renderSidebar();
    const ds = App.state.datasets || [];
    const decks = App.state.decks || [];
    document.getElementById("ds-content").innerHTML =
      this.view === "dataset" ? this.datasetTable(ds, decks) : this.deckList(decks);
  },

  datasetTable(ds, decks) {
    if (!ds.length) return '<div class="empty muted">暂无数据集。请配置 data/config.json 并运行 ingest。</div>';
    const rows = ds.map((d) => {
      const dds = decks.filter((k) => k.versions.some((v) => v.dataset_id === d.id));
      const ready = dds.filter((k) => k.status === "ready").length;
      const rendering = dds.filter((k) => k.status === "rendering").length;
      const failed = dds.filter((k) => k.status === "failed").length;
      return `<tr><td class="ds-name">${d.name}</td><td>${dds.length}</td>
        <td class="ok">${ready}</td><td class="warn">${rendering}</td><td class="err">${failed}</td></tr>`;
    }).join("");
    return `<div class="ds-table-wrap"><table>
      <tr><th>数据集</th><th>Deck 数</th><th>就绪</th><th>渲染中</th><th>失败</th></tr>${rows}
    </table></div>`;
  },

  deckList(decks) {
    let list = decks.slice();
    if (this.filter !== "all") list = list.filter((d) => d.status === this.filter);
    const dsName = (id) => (App.state.datasets.find((x) => x.id === id) || {}).name || String(id);
    return `<div class="ds-table-wrap"><div class="ds-deck-head">Deck 进度（${list.length}/${decks.length}）</div>` +
      (list.length ? list.map((d) => {
        const vs = d.versions.map((v) =>
          `<span class="vs ${v.status}">${dsName(v.dataset_id)} · ${v.status === "ready" ? (v.page_count || 0) + "p" : v.status}</span>`).join(" ");
        return `<div class="deck-status">
          <span class="dot ${d.status}"></span>
          <span class="ds-deck-name">${d.name}</span>
          <span class="vs-row">${vs}</span>
        </div>`;
      }).join("") : '<div class="empty muted">无匹配的 Deck</div>') + '</div>';
  },

  setFilter(f) { this.filter = f; segSelect("ds-filter-seg", "st", f); this.render(); },
  setView(v) { this.view = v; segSelect("ds-view-seg", "view", v); this.render(); },

  bind() {
    document.querySelectorAll("#ds-filter-seg button").forEach((b) =>
      b.addEventListener("click", () => this.setFilter(b.dataset.st)));
    document.querySelectorAll("#ds-view-seg button").forEach((b) =>
      b.addEventListener("click", () => this.setView(b.dataset.view)));
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
