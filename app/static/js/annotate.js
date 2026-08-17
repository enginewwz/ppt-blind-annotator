/* 标注视图：自由排布卡片（移动 / 八向缩放 / 可重叠联动），同步·独立翻页、乱序盲测、打分（排名+评分）、2s 防抖保存。 */
const Annotate = (() => {
  let st = null;      // 当前标注状态
  let timer = null;
  let spaceDown = false;   // 空格+滚轮 → 滚动卡片流
  let dirty = false;       // 是否有未保存改动

  const PAD = 12;          // 画布内边距
  const GAP = 12;          // 卡片间距
  const SCROLLBAR = 16;    // 竖向滚动条预留宽：避免出现竖向滚动条时横向溢出
  const MIN_W = 260;       // 卡片最小宽度（保证评分/排名按钮不折叠）
  const MIN_H = 260;       // 卡片最小高度
  const HEADER_H = 136;    // 卡片头部近似高度（名字+页码+评分+排名）
  const OVERLAP_AUTOARRANGE_THRESHOLD = 16;   // 供对比组数超过此值：关闭重叠退化为自动排列
  const FULL_RATIO = 0.5;  // 显示宽度/原图宽度 > 此值 → 用原图（另：超过缩略图原始大小也用原图）

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function openDeck(deck, opts) {
    clearImageCache();   // 换 Deck/换目录：清 URL 并重置路径标记，卡片重新拉取最新图
    const sameDeck = !!(st && st.deck && st.deck.id === deck.id);
    const noShuffle = !!(opts && opts.noShuffle);
    // 保留上一个 Deck 的布局样式（列数/按列模式/卡片位置与大小），切到不同 Deck 沿用
    const prevLayout = st ? {
      cols: st.cols, colMode: st.colMode, boxes: st.boxes, _lastW: st._lastW,
    } : null;
    close();
    const versions = deck.versions || [];
    const keepLayout = !!(prevLayout && prevLayout.boxes &&
      prevLayout.boxes.length === versions.length);
    st = {
      deck,
      baseOrder: versions.map((_, i) => i),
      order: versions.map((_, i) => i),
      page: versions.map(() => 0),
      sync: !!App.state.prefs.sync_page,
      best: null,
      worst: null,
      scores: {},
      status: "draft",
      lastWheel: versions.map(() => 0),
      cols: keepLayout ? prevLayout.cols : (App.state.prefs.cols || 4),
      colMode: keepLayout ? prevLayout.colMode : true,
      overlap: !!App.state.prefs.overlap,
      auto: !!App.state.prefs.auto,
      boxes: keepLayout ? prevLayout.boxes.map((b) => (b ? { ...b } : null)) : versions.map(() => null),
      selected: null,
      nextDist: 0,          // 到底后继续下翻的累计距离（判完后跳下一 Deck 用）
      _lastW: keepLayout ? prevLayout._lastW : 0,
      effCols: 0,
    };
    showBottomHint(null);   // 新开 Deck：隐藏底部提示
    // 切换到「不同」的 Deck 时乱序；重选当前 Deck / 搜索 Enter 不重新乱序
    if (!sameDeck && !noShuffle && App.state.prefs.shuffle) {
      st.order = shuffled(st.baseOrder);
    }
    dirty = false;
    const ann = App.state.annotations[deck.id];
    if (ann) {
      st.best = ann.best ?? null;
      st.worst = ann.worst ?? null;
      st.scores = Object.assign({}, ann.scores || {});
      st.status = ann.status || "draft";
    }
    document.getElementById("annot-deck-name").textContent = deck.name;
    syncToggle("sync-page", st.sync);
    syncToggle("shuffle", !!App.state.prefs.shuffle);
    syncToggle("overlap", st.overlap);
    syncToggle("auto-arrange", st.auto);
    document.getElementById("annot-saved").textContent = "";
    App.statusBarDeck(deck);
    renderColumns(keepLayout);
    updateImages();
    renderPageNav();
  }

  function close() {
    flush();   // 切换/关闭前保存当前草稿（只在有改动时落盘）
    if (timer) clearTimeout(timer);
    st = null;
    showBottomHint(null);   // 关闭/切换：隐藏底部提示
    const b = document.getElementById("board");
    if (b) b.innerHTML = "";
    // 清空工具栏残留：Deck 名、保存提示（切换 Deck 时 openDeck 会随后重新设置）；
    // 全局页码在无 Deck 时显示占位 - / -（与首次打开一致）
    document.getElementById("annot-deck-name").textContent = "";
    document.getElementById("pg-indicator").textContent = "- / -";
    document.getElementById("annot-saved").textContent = "";
  }

  function totalPages() { return st && st.deck.page_count ? st.deck.page_count : 1; }
  function curPage(i) { return st.sync ? (st.page[0] || 0) : (st.page[i] || 0); }

  function setPage(delta, col) {
    if (!st) return;
    if (st.sync) {
      const maxP = totalPages();               // 最长的 PPT 页数（同步以它为准）
      const cur = st.page[0] || 0;
      if (delta > 0 && cur >= maxP - 1) { scrollBoard(1); return; }   // 最后一个也翻完 → 整体下翻
      if (delta < 0 && cur <= 0) { scrollBoard(-1); return; }         // 全部到第一页 → 整体上翻
      const np = Math.min(Math.max(cur + delta, 0), maxP - 1);
      st.page = st.page.map(() => np);         // 页数不同的 PPT 各自钳制在最后一页
    } else {
      const cur = st.page[col] || 0;
      const v = versionAt(col);
      const max = v && v.pages && v.pages.length ? v.pages.length - 1 : 0;
      if (delta > 0 && cur >= max) { scrollBoard(1); return; }   // 该 PPT 翻到底 → 全局下翻
      if (delta < 0 && cur <= 0) { scrollBoard(-1); return; }    // 翻到第一页 → 全局上翻
      st.page[col] = cur + delta;
    }
    updateImages();
    renderPageNav();
  }

  /* 页首/页尾之后，整体上下滚动卡片流（翻一屏） */
  function scrollBoard(dir) {
    const c = document.getElementById("columns");
    if (!c) return;
    const vh = Math.max(200, c.clientHeight);
    c.scrollBy({ top: dir * vh * 0.85, behavior: "smooth" });
  }

  /* 滚轮翻页：同步模式整组联动，独立模式只翻当前列；250ms 节流防止触控板惯性连翻。
     已翻到最后一页且卡片流滚到底后，继续下翻：本组已判完（选最好/最差 + 全打分，或已提交）→
     显示底部提示并累计距离 → 跳下一 Deck；未判完则提示先判完，不跳转。 */
  const NEXT_DECK_JUMP_DIST = 480;   // 到底后再下翻累计滚轮距离达到此值 → 跳下一 Deck

  /* 当前列是否已翻到最后一页 */
  function atLastPage(i) {
    if (!st) return true;
    if (st.sync) return (st.page[0] || 0) >= totalPages() - 1;
    const v = versionAt(i);
    const max = v && v.pages && v.pages.length ? v.pages.length - 1 : 0;
    return (st.page[i] || 0) >= max;
  }

  /* 卡片流是否已滚到底部（接近底边，阈值 24px） */
  function boardAtBottom() {
    const c = document.getElementById("columns");
    if (!c) return true;
    return c.scrollTop + c.clientHeight >= c.scrollHeight - 24;
  }

  /* 本组是否判完：已提交，或最好/最差都已选且所有数据源都有评分 */
  function deckJudged() {
    if (!st) return false;
    if (st.status === "submitted") return true;
    const n = st.deck.versions.length;
    return st.best != null && st.worst != null &&
      st.scores && Object.keys(st.scores).length >= n;
  }

  /* 底部小字提示（到底后继续下翻时显示；msg=null 隐藏） */
  function showBottomHint(msg) {
    const el = document.getElementById("next-hint");
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; }
  }

  function onWheel(e, col) {
    if (!st) return;
    if (spaceDown) return;   // 空格+滚轮：交给原生滚动（不翻页）
    e.preventDefault();
    const i = Number(col.dataset.idx);
    const now = performance.now();
    if (now - (st.lastWheel[i] || 0) < 250) return;
    st.lastWheel[i] = now;
    const down = e.deltaY > 0;
    if (down && atLastPage(i) && boardAtBottom()) {
      if (!deckJudged()) {
        // 本组未判完：提示先判完，不累计、不跳转
        showBottomHint("本组尚未判完（选最好/最差并打分）后才能进入下一个");
        return;
      }
      st.nextDist = (st.nextDist || 0) + Math.abs(e.deltaY || 100);
      showBottomHint("已到底部 · 继续滚动进入下一个 Deck…");
      if (st.nextDist >= NEXT_DECK_JUMP_DIST) {
        st.nextDist = 0;
        showBottomHint(null);
        App.stepDeck(1);
      }
      return;
    }
    if (st.nextDist) { st.nextDist = 0; showBottomHint(null); }   // 上翻/不在底部 → 复位提示
    setPage(down ? 1 : -1, i);
  }

  function renderPageNav() {
    const p = (st.page[0] || 0) + 1;
    const t = totalPages();
    document.getElementById("pg-indicator").textContent = st.sync ? `${p} / ${t}` : "独立翻页";
    updatePageBadges();
  }

  /* 每列头部显示当前页 / 总页数（独立翻页时尤其有用） */
  function updatePageBadges() {
    document.querySelectorAll("#columns .col").forEach((col) => {
      const i = Number(col.dataset.idx);
      const v = versionAt(i);
      const el = col.querySelector(".col-page");
      if (!el) return;
      if (v && v.status === "ready" && v.pages && v.pages.length) {
        el.textContent = `${Math.min(curPage(i), v.pages.length - 1) + 1} / ${v.page_count} 页`;
      } else {
        el.textContent = "";
      }
    });
  }

  function versionAt(i) { return st.deck.versions[st.order[i]]; }

  function renderColumns(preserveBoxes) {
    const board = document.getElementById("board");
    board.innerHTML = "";
    if (!st || !st.deck.versions.length) {
      board.innerHTML = '<div class="empty muted">该 Deck 没有可用版本。</div>';
      return;
    }
    st.order.forEach((oi, i) => {
      const v = st.deck.versions[oi];
      const col = document.createElement("div");
      col.className = "col";
      col.dataset.idx = String(i);
      col.dataset.dsid = String(v.dataset_id);

      const head = document.createElement("div");
      head.className = "col-head";

      const move = document.createElement("span");
      move.className = "col-move";
      move.title = "拖动移动框体";

      const name = document.createElement("span");
      name.className = "col-name";
      name.textContent = `样本 ${i + 1}`;   // 盲测：不显示来源
      const meta = document.createElement("span");
      meta.className = "col-meta muted";
      meta.textContent = v.status === "ready" ? `${v.page_count} 页` : v.status;
      const pageBadge = document.createElement("span");
      pageBadge.className = "col-page muted";

      const nameRow = document.createElement("div");
      nameRow.className = "col-name-row";
      nameRow.appendChild(move);
      nameRow.appendChild(name);
      nameRow.appendChild(meta);

      const scores = document.createElement("div");
      scores.className = "scores";
      for (let s = 1; s <= 5; s++) {
        const b = document.createElement("button");
        b.className = "score";
        b.textContent = s;
        b.dataset.action = "score";
        b.dataset.val = String(s);
        scores.appendChild(b);
      }
      const ranks = document.createElement("div");
      ranks.className = "ranks";
      const bBest = document.createElement("button");
      bBest.className = "rank best";
      bBest.textContent = "最好";
      bBest.dataset.action = "best";
      const bWorst = document.createElement("button");
      bWorst.className = "rank worst";
      bWorst.textContent = "最差";
      bWorst.dataset.action = "worst";
      ranks.appendChild(bBest);
      ranks.appendChild(bWorst);

      head.appendChild(nameRow);
      head.appendChild(pageBadge);
      head.appendChild(scores);
      head.appendChild(ranks);

      const body = document.createElement("div");
      body.className = "col-body";
      body.title = "滚轮翻页" + (st.sync ? "（同步）" : "（本列独立）");
      // 未就绪时显示占位（渲染中/待处理/失败等），就绪后隐藏、改显图片
      const ph = document.createElement("div");
      ph.className = "col-placeholder muted";
      ph.textContent = "渲染中…";
      const img = document.createElement("img");
      img.className = "slide";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = `样本 ${i + 1}`;
      img.addEventListener("load", () => refreshSrc(img));   // 缩略图加载后按原始大小重新判断
      body.appendChild(ph);
      body.appendChild(img);
      body.addEventListener("wheel", (e) => onWheel(e, col), { passive: false });

      col.appendChild(head);
      col.appendChild(body);

      ["nw", "n", "ne", "w", "e", "sw", "s", "se"].forEach((dir) => {
        const h = document.createElement("div");
        h.className = "rh rh-" + dir;
        h.title = "拖动缩放";
        h.addEventListener("mousedown", (e) => startResize(e, i, dir));
        col.appendChild(h);
      });

      move.addEventListener("mousedown", (e) => startMove(e, i));
      head.addEventListener("mousedown", (e) => {
        if (e.target.closest("button") || e.target.closest(".rh")) return;
        startMove(e, i);
      });

      board.appendChild(col);
    });
    refreshColButtonsAll();
    refreshAllBorders();
    if (preserveBoxes) applyBoxes();   // 乱序/重排时保留卡片位置与大小
    else autoArrange();                // 首次打开：按列排布
    syncLayoutSeg();
  }

  /* ---------- 排布 / 移动 / 缩放 / 重叠联动 ---------- */
  function boardCW() {
    const c = document.getElementById("columns");
    return c ? c.offsetWidth : 800;   // 用 offsetWidth（含滚动条），避免滚动条出现/消失导致抖动
  }
  function boardW() {
    // offsetWidth 含竖向滚动条；再预留滚动条宽度，避免竖向滚动条出现时横向溢出
    return Math.max(420, boardCW() - PAD * 2 - SCROLLBAR);
  }
  function aspectOf() {
    const v = versionAt(0);
    const pg = v && v.pages && v.pages[0];
    return pg && pg.w && pg.h ? pg.w / pg.h : 4 / 3;
  }

  /* 按列排布：每行 st.cols 列，卡片高度跟随 PPT 宽高比（拉伸/压缩填满，过小换行） */
  function autoArrange() {
    if (!st) return;
    const W = boardW();
    st._lastW = W;
    const aspect = aspectOf();
    const want = Math.max(1, Math.min(st.cols, st.boxes.length));
    const fit = Math.max(1, Math.floor((W + GAP) / (MIN_W + GAP)));
    // 迟滞：避免在列数边界来回跳（4↔3 抖动）
    let cols = st.effCols || want;
    if (cols < want && fit >= cols + 1) cols = Math.min(want, cols + 1);
    if (cols > want) cols = want;
    if (cols > fit) cols = Math.max(1, fit);
    st.effCols = cols;
    const w = Math.max(MIN_W, (W - GAP * (cols - 1)) / cols);
    const h = HEADER_H + w / aspect;
    st.boxes = st.boxes.map((_, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      return { x: PAD + c * (w + GAP), y: PAD + r * (h + GAP), w: Math.round(w), h: Math.round(h) };
    });
    applyBoxes();
  }

  /* 关闭「允许重叠」用的排布核心：给定已占用框体 placed，为卡片 b 找「最上、最左」的
     可放下位置（与已占用不重叠、不越出画布右边界）。网格搜索 O(n³)，但只用于「关闭允许
     重叠」这一一次性动作，不用于热路径 arrange()。 */
  function fitsAt(w, h, x, y, placed) {
    // 右边界用「实际可视宽度」：boardCW() 含竖向滚动条，减去 SCROLLBAR 即内容右缘。
    // 之前用 boardW()+PAD（= boardCW()-PAD-SCROLLBAR）多留了一个右 PAD 空档，
    // 会把本可放下的卡片（如样本四紧挨样本三）误判为超宽而掉到下一行。
    if (x + w > boardCW() - SCROLLBAR) return false;   // 不越出可视右边界（预留滚动条）
    for (const p of placed) {
      if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) return false;
    }
    return true;
  }
  function placeNext(placed, b) {
    // 候选 x/y：PAD + 每个已放框体的「左/上缘」与「右/下缘+GAP」，自上而下、自左而右找第一个可放点。
    // 纳入左/上缘可让后一张卡「紧挨/对齐」前一张排（例如样本四紧挨样本三的同一行右侧）。
    const xs = [PAD], ys = [PAD];
    for (const p of placed) {
      xs.push(p.x, p.x + p.w + GAP);
      ys.push(p.y, p.y + p.h + GAP);
    }
    xs.sort((a, c) => a - c);
    ys.sort((a, c) => a - c);
    for (const y of ys) {
      for (const x of xs) {
        if (fitsAt(b.w, b.h, x, y, placed)) return { x, y };
      }
    }
    const bottom = Math.max(PAD, ...placed.map((p) => p.y + p.h + GAP));
    return { x: PAD, y: bottom };
  }

  /* 自动排列（高效 skyline，O(n²)）：保留大小，按左上角(y,x)顺序把每个框体在 skyline 上
     找「最上、最左」的可放位置依次铺排（向上收紧、左靠填空）。
     右边界用「实际可视宽度」boardCW()-SCROLLBAR（只预留滚动条，不再多留右 PAD）：
     否则像样本四紧挨样本三这种「右缘恰好顶到边界」的情形会被误判放不下而掉到下一行。
     注：placeNext 网格搜索是 O(n⁴)，不能用于此热路径（视口缩放/拖分隔条会反复调 arrange）。 */
  function arrange() {
    if (!st) return;
    const right = boardCW() - SCROLLBAR;   // 内容右边界（绝对坐标，预留滚动条）
    st._lastW = boardW();
    const idxs = st.boxes.map((_, i) => i).sort((a, b) => {
      const A = st.boxes[a], B = st.boxes[b];
      return (A.y - B.y) || (A.x - B.x);
    });
    const out = st.boxes.map((b) => ({ ...b }));
    let sky = [{ x: PAD, y: PAD, w: right - PAD }];
    idxs.forEach((idx) => {
      const b = out[idx];
      const pw = b.w + GAP, ph = b.h + GAP;   // 占位尺寸（含间距）
      let best = null;
      for (let si = 0; si < sky.length; si++) {
        let runW = 0, runY = 0;
        for (let sj = si; sj < sky.length; sj++) {
          runW += sky[sj].w;
          runY = Math.max(runY, sky[sj].y);
          if (runW >= b.w) {
            const cand = { x: sky[si].x, y: runY };
            if (!best || cand.y < best.y || (cand.y === best.y && cand.x < best.x)) best = cand;
            break;
          }
        }
      }
      if (!best) {   // 无处可放 → 底部新行
        const bottom = Math.max(...sky.map((s) => s.y));
        best = { x: PAD, y: bottom };
        sky = [{ x: PAD, y: bottom, w: right - PAD }];
      }
      b.x = best.x; b.y = best.y;
      const placedTop = best.y + ph;
      const segEnd = best.x + pw;
      const newSky = [];
      for (const seg of sky) {
        const sEnd = seg.x + seg.w;
        if (sEnd <= best.x || seg.x >= segEnd) { newSky.push(seg); continue; }
        if (seg.x < best.x) newSky.push({ x: seg.x, y: seg.y, w: best.x - seg.x });
        const a = Math.max(seg.x, best.x);
        const z = Math.min(sEnd, segEnd);
        if (a < z) newSky.push({ x: a, y: placedTop, w: z - a });
        if (sEnd > segEnd) newSky.push({ x: segEnd, y: seg.y, w: sEnd - segEnd });
      }
      newSky.sort((p, q) => p.x - q.x);
      sky = [];
      for (const seg of newSky) {
        const last = sky[sky.length - 1];
        if (last && last.x + last.w === seg.x && last.y === seg.y) last.w += seg.w;
        else sky.push({ ...seg });
      }
    });
    st.boxes = out;
    settleAll();          // 兜底：无论输入怎样都保证最终零重叠
    applyBoxes();
  }

  function anyOverlap() {
    for (let j = 0; j < st.boxes.length; j++) {
      for (let k = j + 1; k < st.boxes.length; k++) {
        if (overlapBoxes(st.boxes[j], st.boxes[k])) return true;
      }
    }
    return false;
  }

  /* 全局去重叠：先贪心推开；若极端多卡仍重叠，则按 y 排序纵向堆叠兜底，保证零重叠 */
  function settleAll() {
    if (!st) return;
    for (let pass = 0; pass < 24; pass++) {
      let changed = false;
      for (let j = 0; j < st.boxes.length; j++) {
        for (let k = j + 1; k < st.boxes.length; k++) {
          if (overlapBoxes(st.boxes[j], st.boxes[k])) {
            pushOut(st.boxes[j], st.boxes[k]);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    st.boxes.forEach(clampBox);
    if (anyOverlap()) {
      const idxs = st.boxes.map((_, i) => i).sort((a, b) => st.boxes[a].y - st.boxes[b].y);
      let y = PAD;
      idxs.forEach((idx) => {
        st.boxes[idx].y = y;
        y += st.boxes[idx].h + GAP;
      });
      st.boxes.forEach(clampBox);
    }
  }

  /* 关闭「允许重叠」：分两步——① 先按左上(y,x)优先序贪心选出「互不重叠的保留子集」：
     与已保留者不重叠即留在原位；② 只把其余（补集）经 placeNext 重排到「最上、最左」的
     不重叠位置。相比旧单遍做法（移动后的新位置会连锁挤动后面本不碍事的框），本版先定保留
     子集、只动补集：保留尽量多的框原位不动，移动更少、更可预期。
     兜底：供对比组数超过 OVERLAP_AUTOARRANGE_THRESHOLD 时，placeNext 网格搜索（最坏
     O(n⁴)）会明显变慢，此时直接退化为「自动排列」（skyline O(n²)），保证不卡顿。 */
  function resolveOverlapPreserve() {
    if (!st) return;
    if (st.boxes.length > OVERLAP_AUTOARRANGE_THRESHOLD) { arrange(); return; }
    const order = st.boxes.map((_, i) => i).sort((a, b) => {
      const A = st.boxes[a], B = st.boxes[b];
      return (A.y - B.y) || (A.x - B.x) || (a - b);
    });
    // ① 选保留子集（原位不动）；与已保留者重叠的进补集
    const kept = [];      // 保留框体（对象引用）
    const toMove = [];    // 待移动下标
    for (const idx of order) {
      const b = st.boxes[idx];
      if (kept.some((p) => overlapBoxes(b, p))) toMove.push(idx);
      else kept.push(b);
    }
    // ② 只把补集经 placeNext 重排；已排好的补集也计入占用，保证互不重叠
    const placed = kept.slice();
    for (const idx of toMove) {
      const b = st.boxes[idx];
      const spot = placeNext(placed, b);
      b.x = spot.x; b.y = spot.y;
      placed.push(b);
    }
    applyBoxes();
  }

  /* 视口变化（侧栏拖宽/窗口缩放）：按列模式→重新按列填满；自由模式→按宽度等比拉伸/压缩，
     过小换行；允许重叠时只保证不越界、必要时重叠。绝不横向超出页面。 */
  function relayoutToFit() {
    if (!st) return;
    const W = boardW();
    if (st.colMode) { autoArrange(); return; }
    if (st._lastW && st._lastW > 0) {
      const s = W / st._lastW;
      st.boxes.forEach((b) => {
        b.w = Math.max(MIN_W, Math.round(b.w * s));
        b.h = Math.max(MIN_H, Math.round(b.h * s));
      });
    }
    st._lastW = W;
    if (st.overlap) {
      st.boxes.forEach(clampBox);   // 允许重叠：仅保证不越界
    } else {
      arrange();                    // 不重叠：保留大小换行重排
    }
    applyBoxes();
  }

  function clampBox(b) {
    const cw = boardCW();
    b.x = Math.min(Math.max(0, b.x), Math.max(0, cw - b.w));
    b.y = Math.max(0, b.y);
    b.w = Math.min(Math.max(MIN_W, b.w), cw);
    b.h = Math.max(MIN_H, b.h);
    return b;
  }

  function overlapBoxes(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /* 把 a 从 b 上推开（b 不动）；优先右/下；左/上仅当能完整放下时才采用
     （否则被 clamp 回退到 0 会重新叠上）；横向越界则换行到 b 下方 */
  function pushOut(a, b) {
    const W = boardW();
    const cands = [
      { d: (b.x + b.w) - a.x, f: () => { a.x = b.x + b.w + 2; } },   // 右
      { d: (b.y + b.h) - a.y, f: () => { a.y = b.y + b.h + 2; } },   // 下
    ];
    if (b.x - a.w - 2 >= PAD) cands.push({ d: (a.x + a.w) - b.x, f: () => { a.x = b.x - a.w - 2; } });  // 左
    if (b.y - a.h - 2 >= 0) cands.push({ d: (a.y + a.h) - b.y, f: () => { a.y = b.y - a.h - 2; } });     // 上
    cands.sort((p, q) => p.d - q.d)[0].f();
    if (a.x < PAD) a.x = PAD;
    if (a.x + a.w > W + PAD) { a.x = PAD; a.y = b.y + b.h + 2; }  // 越界 → 换行到下方
  }

  /* 不重叠模式：松手后把被拖动的卡片从别人身上推开（只动自己，不推别人，行为可预期） */
  function settleMoved(i) {
    if (st.overlap) return;
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      for (let j = 0; j < st.boxes.length; j++) {
        if (j === i) continue;
        if (overlapBoxes(st.boxes[i], st.boxes[j])) { pushOut(st.boxes[i], st.boxes[j]); changed = true; }
      }
      if (!changed) break;
    }
    clampBox(st.boxes[i]);
  }

  /* 不允许重叠时缩放：压到谁就先缩谁；缩不动（小于最小尺寸）就放到底下 */
  function resolveResizeOverlap(movedIdx) {
    if (st.overlap) return;
    const b = st.boxes[movedIdx];
    for (let j = 0; j < st.boxes.length; j++) {
      if (j === movedIdx) continue;
      const a = st.boxes[j];
      if (!overlapBoxes(a, b)) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && ox <= oy) {
        const shrink = Math.min(ox, a.w - MIN_W);
        if (shrink > 0) {
          if (a.x < b.x) a.w -= shrink;          // a 在左：缩右缘
          else { a.x += shrink; a.w -= shrink; } // a 在右：缩左缘
        } else {
          a.y = b.y + b.h + GAP;                  // 缩不动 → 放到底下
        }
      } else if (oy > 0) {
        const shrink = Math.min(oy, a.h - MIN_H);
        if (shrink > 0) {
          if (a.y < b.y) a.h -= shrink;          // a 在上：缩下缘
          else { a.y += shrink; a.h -= shrink; } // a 在下：缩上缘
        } else {
          a.y = b.y + b.h + GAP;
        }
      }
      clampBox(a);
    }
  }

  /* 切换按钮高亮状态（同步翻页 / 乱序 / 允许重叠 / 自动排列） */
  function syncToggle(id, on) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("on", !!on);
  }

  /* 选中某张卡：置顶 + 高亮边框（重叠模式下最直观）；传 null 取消选中 */
  function selectCard(i) {
    st.selected = i;
    document.querySelectorAll("#board .col").forEach((col) => {
      const on = Number(col.dataset.idx) === i;
      col.classList.toggle("selected", on);
      col.style.zIndex = on ? "10" : "";
    });
  }

  function applyBoxes() {
    document.querySelectorAll("#board .col").forEach((col) => {
      const i = Number(col.dataset.idx);
      const b = st.boxes[i];
      if (!b) return;
      col.style.left = b.x + "px";
      col.style.top = b.y + "px";
      col.style.width = b.w + "px";
      col.style.height = b.h + "px";
    });
    syncBoardSize();
    refreshAllSrc();
  }

  function syncBoardSize() {
    const board = document.getElementById("board");
    let bottom = PAD;
    st.boxes.forEach((b) => { bottom = Math.max(bottom, b.y + b.h); });
    board.style.height = (bottom + PAD) + "px";
  }

  function syncLayoutSeg() {
    document.querySelectorAll("#layout-seg button").forEach((b) =>
      b.classList.toggle("on", !!(st && st.colMode && Number(b.dataset.cols) === st.cols)));
  }

  /* 通用拖拽 */
  function drag(cursor, moveFn, endFn) {
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    const move = (ev) => moveFn(ev);
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (endFn) endFn();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function startMove(e, i) {
    if (!st) return;
    e.preventDefault();
    e.stopPropagation();
    st.colMode = false;                // 手动移动 → 退出按列排列（按钮熄灭）
    syncLayoutSeg();
    const b = st.boxes[i];
    const col = document.querySelector(`#board .col[data-idx="${i}"]`);
    selectCard(i);
    if (col) col.classList.add("moving");   // 拖动中半透明
    const sx = e.clientX, sy = e.clientY;
    const ox = b.x, oy = b.y;
    drag("move",
      (ev) => {
        b.x = ox + (ev.clientX - sx);
        b.y = oy + (ev.clientY - sy);
        clampBox(b);
        applyBoxes();          // 拖动中自由移动，不做碰撞
      },
      () => {
        if (col) col.classList.remove("moving");
        try {
          settleMoved(i);
          if (!st.overlap) settleAll();   // 兜底：释放后保证零重叠
          if (st.auto) arrange();
        } catch (err) { if (window.OpLog) OpLog.add("移动结束错误: " + err.message); }
        applyBoxes();
        refreshAllSrc();
      });
  }

  function startResize(e, i, dir) {
    if (!st) return;
    e.preventDefault();
    e.stopPropagation();
    st.colMode = false;                // 手动缩放 → 退出按列排列
    syncLayoutSeg();
    const b = st.boxes[i];
    selectCard(i);
    const sx = e.clientX, sy = e.clientY;
    const o = { ...b };
    drag(dirCursor(dir),
      (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        const W = boardW();
        let { x, y, w, h } = o;
        if (dir.includes("e")) w = o.w + dx;
        if (dir.includes("s")) h = o.h + dy;
        if (dir.includes("w")) { w = o.w - dx; x = o.x + dx; }
        if (dir.includes("n")) { h = o.h - dy; y = o.y + dy; }
        if (w < MIN_W) { if (dir.includes("w")) x = o.x + o.w - MIN_W; w = MIN_W; }
        if (h < MIN_H) { if (dir.includes("n")) y = o.y + o.h - MIN_H; h = MIN_H; }
        x = Math.max(0, x);
        y = Math.max(0, y);
        if (x + w > W) { if (dir.includes("w")) x = Math.max(0, W - w); else w = W - x; }
        b.x = x; b.y = y; b.w = Math.max(MIN_W, w); b.h = Math.max(MIN_H, h);
        if (!st.overlap) resolveResizeOverlap(i);   // 不允许重叠：压到谁先缩谁
        applyBoxes();
      },
      () => {
        try {
          settleMoved(i);
          if (!st.overlap) settleAll();   // 兜底：释放后保证零重叠
          if (st.auto) arrange();
        } catch (err) { if (window.OpLog) OpLog.add("缩放结束错误: " + err.message); }
        applyBoxes();
        refreshAllSrc();
      });
  }

  function dirCursor(dir) {
    return { n: "ns-resize", s: "ns-resize", w: "ew-resize", e: "ew-resize",
             nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" }[dir] || "move";
  }

  /* 清图片缓存：撤销 Blob URL 并清除 img 上的 currentPath 标记，使所有卡片在下次 refreshSrc 时重新拉取。
     只清 URL 不清 currentPath 会让「已撤销 URL 的图」因路径未变而跳过重载 → 显示破碎图标（如换目录/换 Deck 后）。 */
  function clearImageCache() {
    if (FS.clearUrlCache) FS.clearUrlCache();
    document.querySelectorAll("#board .col .slide").forEach((img) => { delete img.dataset.currentPath; });
  }

  function updateImages() {
    if (!st) return;
    document.querySelectorAll("#board .col").forEach((col) => {
      const i = Number(col.dataset.idx);
      const v = versionAt(i);
      const img = col.querySelector(".slide");
      // 状态文字随版本刷新：ready → “N 页”，否则显示当前状态（渲染中/待处理/失败等）
      const meta = col.querySelector(".col-meta");
      if (meta) {
        meta.textContent = v && v.status === "ready"
          ? `${v.page_count} 页`
          : (v ? v.status : "");
      }
      if (!v || v.status !== "ready" || !v.pages || !v.pages.length) {
        img.style.display = "none";
        const ph = col.querySelector(".col-placeholder");
        if (ph) {
          ph.style.display = "";
          ph.textContent = !v ? "无版本"
            : v.status === "failed" ? "渲染失败"
            : v.evicted ? "缓存已清理"
            : v.status === "rendering" ? "渲染中…"
            : "待处理…";
        }
        return;
      }
      const pg = v.pages[Math.min(curPage(i), v.pages.length - 1)];
      img.style.display = "";
      const ph = col.querySelector(".col-placeholder");
      if (ph) ph.style.display = "none";
      img.dataset.thumbPath = pg.thumb;   // manifest 内相对所选 data 目录的路径
      img.dataset.fullPath = pg.src;
      img.dataset.pgW = String(pg.w || 0);
      // 不重置 current：换页/换图时路径变化，refreshSrc 自然重载；
      // 同图时不重复赋值 src，避免反复重载图片
      refreshSrc(img).catch(() => {});
    });
  }

  /* 显示宽度超过缩略图原始大小（或超过原图 50%）时用原图，否则用缩略图；每次换页/换 Deck/缩放都重新判断 */
  async function refreshSrc(img) {
    const col = img.closest(".col");
    const body = col && col.querySelector(".col-body");
    const pgW = Number(img.dataset.pgW) || 0;
    const dispW = body ? body.clientWidth : 0;
    // 记住缩略图原始宽度：当前正显示缩略图时读取 naturalWidth
    if (img.dataset.currentPath === img.dataset.thumbPath && img.naturalWidth) {
      img.dataset.thumbW = String(img.naturalWidth);
    }
    const thumbW = Number(img.dataset.thumbW) || 0;
    const useFull = pgW && ((thumbW && dispW > thumbW) || dispW / pgW > FULL_RATIO);
    const path = useFull ? img.dataset.fullPath : img.dataset.thumbPath;
    if (path && img.dataset.currentPath !== path) {
      img.dataset.currentPath = path;
      try {
        const url = await FS.fileUrl(path);   // 经所选目录句柄读图 → Blob URL（任意路径可用）
        if (img.dataset.currentPath !== path) return;   // 期间已切到别的页/图
        // 先解码再换 src：避免大图（原始图）加载/解码期间旧图被清空 → 翻页闪动
        await new Promise((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve();
          probe.onerror = () => resolve();
          probe.src = url;
        });
        if (img.dataset.currentPath !== path) return;
        img.src = url;
      } catch (_) { /* 图片缺失：保持空白 */ }
    }
  }
  function refreshAllSrc() {
    document.querySelectorAll("#board .col .slide").forEach((img) => {
      refreshSrc(img).catch(() => {});
    });
  }

  function onColClick(ev) {
    const img = ev.target.closest("img.slide");
    if (img) {
      const col = img.closest(".col");
      const i = Number(col.dataset.idx);
      if (st.selected !== i) { selectCard(i); return; }  // 未选中：先选中，不放大
      toggleFull(img);                                     // 已选中：再点放大
      return;
    }
    const btn = ev.target.closest("button");
    if (btn) {
      if (!st) return;
      const col = btn.closest(".col");
      const i = Number(col.dataset.idx);
      const v = versionAt(i);
      const a = btn.dataset.action;
      if (a === "score") {
        const s = Number(btn.dataset.val);
        if (st.scores[v.dataset_id] === s) delete st.scores[v.dataset_id];
        else st.scores[v.dataset_id] = s;
        refreshColButtons(col);
        markDirty();
      } else if (a === "best") {
        st.best = st.best === v.dataset_id ? null : v.dataset_id;
        if (st.best !== null && st.worst === st.best) st.worst = null;  // 最好/最差不能是同一组
        refreshColButtonsAll();
        refreshAllBorders();
        markDirty();
      } else if (a === "worst") {
        st.worst = st.worst === v.dataset_id ? null : v.dataset_id;
        if (st.worst !== null && st.best === st.worst) st.best = null;  // 最好/最差不能是同一组
        refreshColButtonsAll();
        refreshAllBorders();
        markDirty();
      }
      return;
    }
    // 点击框体任意其它部位（含图片下方灰区）→ 选中该框
    const col = ev.target.closest(".col");
    if (col && st) selectCard(Number(col.dataset.idx));
  }

  function toggleFull(img) {
    if (!st || !img.dataset.fullPath) return;
    const lb = document.getElementById("lightbox");
    FS.fileUrl(img.dataset.fullPath).then((url) => {
      document.getElementById("lightbox-img").src = url;
    }).catch(() => {});
    lb.hidden = false;
  }

  function refreshColButtons(col) {
    col.querySelectorAll(".score").forEach((b) =>
      b.classList.toggle("on", st.scores[col.dataset.dsid] === Number(b.dataset.val)));
    col.querySelector(".rank.best").classList.toggle("on", st.best === Number(col.dataset.dsid));
    col.querySelector(".rank.worst").classList.toggle("on", st.worst === Number(col.dataset.dsid));
  }
  function refreshColButtonsAll() {
    document.querySelectorAll("#columns .col").forEach(refreshColButtons);
  }
  function refreshAllBorders() {
    document.querySelectorAll("#columns .col").forEach((col) => {
      const dsid = Number(col.dataset.dsid);
      col.classList.toggle("ranked-best", st.best === dsid);
      col.classList.toggle("ranked-worst", st.worst === dsid);
    });
  }

  /* 当前标注快照：status 传 "draft" 或 "submitted"；提交时间保留旧值或首次生成 */
  function snapshot(status) {
    const prev = App.state.savedAnnotations[st.deck.id] || null;
    const wasSubmitted = prev && prev.submitted_at;
    const submitted_at = status === "submitted"
      ? (wasSubmitted || new Date().toISOString())
      : (wasSubmitted || null);
    return {
      status,
      best: st.best,
      worst: st.worst,
      scores: Object.assign({}, st.scores),
      updated_at: new Date().toISOString(),
      submitted_at,
    };
  }

  /* 乐观更新：只更新内存与侧栏标记（●/✓），不自动落盘（保存时机见 flush / save） */
  function markDirty() {
    if (!st) return;
    dirty = true;
    App.state.annotations[st.deck.id] = snapshot(st.status === "submitted" ? "submitted" : "draft");
    Explorer.render();
    document.getElementById("annot-saved").textContent = "未保存";
  }

  /* 手动保存：保存草稿 / 提交 */
  async function save(submit) {
    if (!st) return;
    const next = snapshot(submit ? "submitted" : "draft");
    st.status = next.status;
    document.getElementById("annot-saved").textContent = "保存中…";
    try {
      await App.saveAnnotation(st.deck.id, next);
      dirty = false;
      document.getElementById("annot-saved").textContent = submit ? "已提交 ✓" : "已保存 ✓";
    } catch (e) {
      document.getElementById("annot-saved").textContent = "保存失败";
      if (window.OpLog) OpLog.add("保存失败 " + st.deck.name + ": " + e.message);
    }
    if (submit) App.stepDeck(1);
  }

  /* 切换/关闭前落盘当前草稿：仅在有实际改动时写（翻页/移动/缩放不置脏，不落盘）。
     返回 Promise，供 setView 等在渲染报告前等待落盘完成（避免把未保存草稿误计为已标注）。 */
  function flush() {
    if (!st || !dirty) return Promise.resolve();
    const id = st.deck.id;
    const status = st.status === "submitted" ? "submitted" : "draft";
    const next = snapshot(status);
    const prev = App.state.savedAnnotations[id] || null;
    if (sameAnno(prev, next)) { dirty = false; return Promise.resolve(); }   // 内容未变（仅时间戳）→ 不写
    dirty = false;
    document.getElementById("annot-saved").textContent = "保存中…";
    return App.saveAnnotation(id, next).then(() => {
      if (st && st.deck.id === id) document.getElementById("annot-saved").textContent = "已保存 ✓";
    }).catch(() => {
      dirty = true;
      if (window.OpLog) OpLog.add("自动保存失败 " + id);
    });
  }

  /* 供外部（清空按钮）使用 */
  function hasDeck() { return !!st; }
  function currentDeckId() { return st ? st.deck.id : null; }
  function resetCurrent() {
    if (!st) return;
    st.best = null; st.worst = null; st.scores = {}; st.status = "draft";
    dirty = false;
    refreshColButtonsAll();
    refreshAllBorders();
    document.getElementById("annot-saved").textContent = "已清空";
  }

  function refreshStatus(deck) {
    if (st && st.deck.id === deck.id) {
      const prevCount = st.deck.versions.length;
      const wasReady = st.deck.status === "ready";
      // 只有「版本数变化 / 某版本变为 ready / 源变化（重渲）」才清缓存取最新图；
      // 否则（就绪且未变）不清——避免轮询时反复撤销 Blob URL + 清 currentPath，导致原图无故闪动。
      const needClear = deck.versions.length !== prevCount ||
        deck.versions.some((n) => {
          const o = st.deck.versions.find((x) => x.dataset_id === n.dataset_id);
          return !o || o.src_key !== n.src_key || (o.status !== "ready" && n.status === "ready");
        });
      if (needClear) clearImageCache();   // 取最新渲染的图片
      st.deck = deck;
      if (deck.versions.length !== prevCount) {
        // 数据源数量变化：重建卡片（保留列数偏好，重新按列排；已评分数/排名保留）
        st.baseOrder = deck.versions.map((_, i) => i);
        st.order = App.state.prefs.shuffle ? shuffled(st.baseOrder) : st.baseOrder.slice();
        st.page = deck.versions.map(() => 0);
        st.lastWheel = deck.versions.map(() => 0);
        st.boxes = deck.versions.map(() => null);
        st.effCols = 0;
        renderColumns(false);
        updateImages();
        renderPageNav();
      } else if (needClear || !(wasReady && deck.status === "ready")) {
        // 状态变化（pending/rendering → ready）或重渲才刷新图片与状态文字；
        // 已就绪且未变 → 画布已是最终态，不清缓存不刷新（目录棕点仍由 Explorer 持续更新）
        updateImages();
        renderPageNav();
      }
    }
  }

  /* 从其它页面切回标注页时：布局可见后按框体实际大小重新判断原图/缩略图 */
  function onShown() {
    if (!st) return;
    requestAnimationFrame(() => refreshAllSrc());
  }

  function bind() {
    document.getElementById("columns").addEventListener("click", onColClick);
    // 单击空白处取消选中
    document.getElementById("board").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) selectCard(null);
    });

    // 同步翻页：单击切换（页码紧跟其后）
    document.getElementById("sync-page").addEventListener("click", () => {
      if (!st) return;
      st.sync = !st.sync;
      App.state.prefs.sync_page = st.sync;
      App.savePrefs();
      syncToggle("sync-page", st.sync);
      updateImages();
      renderPageNav();
    });
    // 乱序：单击立即乱序/恢复当前 Deck（并记忆偏好）
    document.getElementById("shuffle").addEventListener("click", () => {
      App.state.prefs.shuffle = !App.state.prefs.shuffle;
      App.savePrefs();
      syncToggle("shuffle", App.state.prefs.shuffle);
      if (!st) return;
      st.order = App.state.prefs.shuffle ? shuffled(st.baseOrder) : st.baseOrder.slice();
      renderColumns(true);   // 立即生效，保留位置与大小
      updateImages();
    });
    // 允许重叠：单击切换（须先关闭自动排列）
    document.getElementById("overlap").addEventListener("click", () => {
      if (!st) return;
      if (st.auto) {
        st.auto = false;
        App.state.prefs.auto = false;
        syncToggle("auto-arrange", false);
      }
      st.overlap = !st.overlap;
      App.state.prefs.overlap = st.overlap;
      App.savePrefs();
      syncToggle("overlap", st.overlap);
      if (!st.overlap) resolveOverlapPreserve();   // 关闭允许重叠 → 先选不重叠保留子集、只移动重叠补集
    });
    // 自动排列：单击=排一遍/取消；双击=开启连续自动排列（开启时强制关闭允许重叠）
    let autoClickTimer = null;
    const autoBtn = document.getElementById("auto-arrange");
    autoBtn.addEventListener("click", () => {
      if (autoClickTimer) clearTimeout(autoClickTimer);
      autoClickTimer = setTimeout(() => {
        autoClickTimer = null;
        if (!st) return;
        if (st.auto) {
          st.auto = false;
          App.state.prefs.auto = false;
          App.savePrefs();
          syncToggle("auto-arrange", false);
        } else {
          // 未选中时单击：有列布局→按列排；自由模式→skyline 自动打包
          if (st.colMode) autoArrange(); else arrange();
        }
      }, 250);
    });
    autoBtn.addEventListener("dblclick", () => {
      if (autoClickTimer) { clearTimeout(autoClickTimer); autoClickTimer = null; }
      if (!st) return;
      st.auto = true;
      st.overlap = false;
      App.state.prefs.auto = true;
      App.state.prefs.overlap = false;
      App.savePrefs();
      syncToggle("auto-arrange", true);
      syncToggle("overlap", false);
      arrange();
    });

    document.getElementById("btn-submit").addEventListener("click", () => save(true));
    document.getElementById("btn-save-draft").addEventListener("click", () => save(false));
    document.getElementById("btn-prev-deck").addEventListener("click", () => App.stepDeck(-1));
    document.getElementById("btn-next-deck").addEventListener("click", () => App.stepDeck(1));

    // 布局：每行 N 列（图标按钮）→ 进入按列排列模式
    document.querySelectorAll("#layout-seg button").forEach((b) =>
      b.addEventListener("click", () => {
        if (!st) return;
        st.cols = Number(b.dataset.cols);
        st.colMode = true;
        App.state.prefs.cols = st.cols;
        App.savePrefs();
        autoArrange();
        syncLayoutSeg();
      }));

    // 空格 + 滚轮 = 滚动卡片流（不翻页）；普通滚轮在卡片上 = 翻页
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        spaceDown = true;
        if (!/^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space") spaceDown = false;
    });
    window.addEventListener("resize", () => {
      if (!st) return;
      relayoutToFit();
    });

    // 图片放大查看器：点击背景 / 按 Esc 关闭
    const lb = document.getElementById("lightbox");
    lb.addEventListener("click", () => { lb.hidden = true; });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && lb && !lb.hidden) lb.hidden = true;
    });
  }

  return { openDeck, close, bind, refreshStatus, onViewportResize: relayoutToFit, onShown,
           hasDeck, currentDeckId, resetCurrent, hasDirty: () => dirty, flush };
})();
