/* Deck 列表（侧边栏）。虚拟滚动——只渲染可见窗口（±OVERSCAN），数百~上千 Deck 也流畅。 */
const Explorer = (() => {
  let filter = "";
  let statusFilter = "all";   // all | pending | done
  let visible = [];
  let scrollTop = 0;          // 虚拟滚动当前滚动位置
  let bound = false;          // 滚动监听只绑定一次
  let rafPending = false;     // rAF 节流
  const ROW_H = 26;           // 每行估算高度（px）
  const OVERSCAN = 8;         // 可见窗口上下多渲染行数（滚动更顺）

  /* 完成判定：已提交，或最好/最差都已选且各数据集都有评分 */
  function isDone(deck) {
    const ann = App.state.annotations[deck.id];
    if (!ann) return false;
    if (ann.status === "submitted") return true;
    return ann.best != null && ann.worst != null &&
      ann.scores && Object.keys(ann.scores).length >= deck.versions.length;
  }

  function applyFilter(q) {
    filter = (q || "").trim().toLowerCase();
    scrollTop = 0;   // 换过滤条件 → 回到顶部
    render();
  }
  function setStatusFilter(f) {
    statusFilter = f || "all";
    scrollTop = 0;
    render();
  }

  function firstMatch() {
    const ready = visible.find((d) => d.status === "ready");
    return ready || visible[0] || null;
  }

  function render() {
    const list = document.getElementById("deck-list");
    if (!list) return;
    let all = App.state.decks.slice();
    if (filter) all = all.filter((d) => d.name.toLowerCase().includes(filter));
    if (statusFilter === "done") all = all.filter((d) => isDone(d));
    else if (statusFilter === "pending") all = all.filter((d) => !isDone(d));
    visible = all;
    const total = visible.length;

    // 虚拟滚动：只渲染可见窗口（±OVERSCAN），上下用占位撑起滚动条高度
    const viewH = list.clientHeight || 300;
    const maxTop = Math.max(0, total * ROW_H - viewH);
    if (scrollTop > maxTop) scrollTop = maxTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
    const spacer = (h) => {
      const d = document.createElement("div");
      d.style.height = Math.max(0, h) + "px";
      d.style.overflow = "hidden";
      return d;
    };

    list.innerHTML = "";
    list.appendChild(spacer(start * ROW_H));
    for (let i = start; i < end; i++) list.appendChild(row(visible[i]));
    list.appendChild(spacer((total - end) * ROW_H));

    const ready = all.filter((d) => d.status === "ready").length;
    document.getElementById("sidebar-count").textContent = `${total} 个 · 就绪 ${ready}`;
    bindScroll();
  }

  /* 滚动时按位置重渲窗口（rAF 节流；只绑定一次） */
  function bindScroll() {
    if (bound) return;
    const list = document.getElementById("deck-list");
    if (!list) return;
    bound = true;
    list.addEventListener("scroll", () => {
      scrollTop = list.scrollTop;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        render();
      });
    });
  }

  function row(deck) {
    const el = document.createElement("div");
    el.className = "deck-row" + (App.state.currentDeckId === deck.id ? " active" : "");
    // 缓存已被上限清理（evicted）：显示为「缓存清理」，点击即请求优先重渲
    const evicted = deck.evicted === true ||
      (!!deck.versions && deck.versions.length > 0 && deck.versions.every((v) => v.evicted));
    const dot = document.createElement("span");
    dot.className = "dot " + (evicted ? "evicted" : (deck.status || "pending"));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = deck.name;
    const badge = document.createElement("span");
    badge.className = "badge";
    const ann = App.state.annotations[deck.id];
    if (ann) {
      const done = isDone(deck);
      badge.classList.add(done ? "done" : "draft");
      badge.textContent = done ? "✓" : "●";
    } else if (evicted) {
      badge.classList.add("evicted");
      badge.textContent = "缓存清理";
      badge.title = "渲染产物已被缓存上限清理，点击以优先重渲";
    } else if (deck.status === "ready") {
      badge.classList.add("none");          // 未标注（含清空后）→ 灰点
      badge.textContent = "●";
      badge.title = deck.page_count + " 页 · 未标注";
    } else {
      badge.textContent = deck.status === "rendering" ? "渲染中"
        : deck.status === "failed" ? "失败" : "";
    }
    el.appendChild(dot);
    el.appendChild(name);
    el.appendChild(badge);
    el.addEventListener("click", () => {
      // 未就绪也可点进：选中 + 显示占位框，就绪后自动填图（App.openDeck 内部会请求插队渲染）
      App.openDeck(deck.id, { allowPending: deck.status !== "ready" });
    });
    return el;
  }

  return { render, applyFilter, setStatusFilter, firstMatch };
})();
