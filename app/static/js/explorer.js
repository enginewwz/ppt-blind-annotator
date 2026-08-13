/* Deck 列表（侧边栏）。M2 简化：先渲染前 500；M4 换虚拟滚动。 */
const Explorer = (() => {
  let filter = "";
  let statusFilter = "all";   // all | pending | done
  let visible = [];

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
    render();
  }
  function setStatusFilter(f) {
    statusFilter = f || "all";
    render();
  }

  function firstMatch() {
    const ready = visible.find((d) => d.status === "ready");
    return ready || visible[0] || null;
  }

  function render() {
    const list = document.getElementById("deck-list");
    let all = App.state.decks.slice();
    if (filter) all = all.filter((d) => d.name.toLowerCase().includes(filter));
    if (statusFilter === "done") all = all.filter((d) => isDone(d));
    else if (statusFilter === "pending") all = all.filter((d) => !isDone(d));
    visible = all;
    list.innerHTML = "";
    all.slice(0, 500).forEach((d) => list.appendChild(row(d)));
    const ready = all.filter((d) => d.status === "ready").length;
    document.getElementById("sidebar-count").textContent = `${all.length} 个 · 就绪 ${ready}`;
  }

  function row(deck) {
    const el = document.createElement("div");
    el.className = "deck-row" + (App.state.currentDeckId === deck.id ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "dot " + (deck.status || "pending");
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
      if (deck.status === "ready") App.openDeck(deck.id);
      else document.getElementById("sb-annot").textContent = deck.name + " 渲染中，请稍候…";
    });
    return el;
  }

  return { render, applyFilter, setStatusFilter, firstMatch };
})();
