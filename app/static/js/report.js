/* 报告视图：在浏览器内基于 manifest + 标注实时聚合展示（与 scripts/report.py 同口径）。
   完整离线 HTML/CSV/JSON 由 `python scripts/report.py` 生成到 reports/（HTML 内联柱状图 + 回链）。 */
const Report = {
  /* 一组分数的统计：count / mean / median / variance / stddev / distribution{1..5}（与 report.py 一致） */
  scoreStats(scores) {
    const xs = (scores || []).filter((n) => typeof n === "number" && n >= 1 && n <= 5);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    xs.forEach((x) => { dist[Math.round(x)]++; });
    if (!xs.length) {
      return { count: 0, mean: null, median: null, variance: null, stddev: null, distribution: dist };
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sorted = xs.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    return {
      count: xs.length,
      mean: +mean.toFixed(4),
      median: +median.toFixed(4),
      variance: +variance.toFixed(4),
      stddev: +Math.sqrt(variance).toFixed(4),
      distribution: dist,
    };
  },

  /* 从 App.state（manifest + annotations）聚合出报告结构（与 report.py 的 aggregate 一致） */
  aggregate() {
    const datasets = App.state.datasets || [];
    const decks = App.state.decks || [];
    const annotations = App.state.annotations || {};
    const dsById = {};
    datasets.forEach((d) => { dsById[d.id] = d.name; });
    const dsAgg = {};
    datasets.forEach((d) => {
      dsAgg[d.id] = { id: d.id, name: d.name, decks: 0, annotated: 0, scores: [], best: 0, worst: 0 };
    });
    const rows = [];
    const totals = { decks: decks.length, annotated: 0, submitted: 0, draft: 0 };

    decks.forEach((deck) => {
      const a = annotations[deck.id] || null;
      const row = {
        id: deck.id, name: deck.name,
        status: a ? (a.status || "") : "",
        annotated: !!a,
        updated_at: a ? (a.updated_at || "") : "",
        submitted_at: a ? (a.submitted_at || "") : "",
        best: a ? a.best : null,
        worst: a ? a.worst : null,
        versions: [],
      };
      (deck.versions || []).forEach((v) => {
        const agg = dsAgg[v.dataset_id];
        if (!agg) return;
        agg.decks++;
        if (a) {
          agg.annotated++;
          const sc = a.scores ? (a.scores[v.dataset_id] ?? null) : null;
          if (typeof sc === "number" && sc >= 1 && sc <= 5) agg.scores.push(sc);
          if (a.best === v.dataset_id) agg.best++;
          if (a.worst === v.dataset_id) agg.worst++;
        }
        row.versions.push({
          dataset_id: v.dataset_id,
          dataset: dsById[v.dataset_id] || ("#" + v.dataset_id),
          score: a && a.scores ? (a.scores[v.dataset_id] ?? null) : null,
          rank: a && a.best === v.dataset_id && a.worst === v.dataset_id ? "both"
            : a && a.best === v.dataset_id ? "best"
            : a && a.worst === v.dataset_id ? "worst" : "",
        });
      });
      if (a) {
        totals.annotated++;
        if (a.status === "submitted") totals.submitted++;
        else if (a.status === "draft") totals.draft++;
      }
      rows.push(row);
    });

    const datasetsOut = datasets.map((d) => {
      const g = dsAgg[d.id];
      const st = this.scoreStats(g.scores);
      return {
        id: d.id, name: d.name, decks: g.decks, annotated: g.annotated,
        score: st, best: g.best, worst: g.worst,
      };
    });
    return { generated_at: new Date().toISOString(), totals, datasets: datasetsOut, decks: rows };
  },

  /* 分数分布的内联 CSS 柱状图 HTML（1..5 各一柱，高度按最大值归一） */
  bars(dist) {
    const max = Math.max(1, ...[1, 2, 3, 4, 5].map((s) => dist[s] || 0));
    return [1, 2, 3, 4, 5].map((s) => {
      const cnt = dist[s] || 0;
      const h = Math.round((cnt / max) * 100);
      return `<div class="rep-bar" title="${s} 分：${cnt} 个">
        <div class="rep-bar-track"><div class="rep-bar-fill" style="height:${h}%"></div></div>
        <span class="rep-bar-val">${cnt}</span>
        <span class="rep-bar-label">${s}</span>
      </div>`;
    }).join("");
  },

  render() {
    const box = document.getElementById("report-box");
    if (!box) return;
    const datasets = App.state.datasets || [];
    if (!datasets.length) {
      box.innerHTML = '<p class="muted">暂无数据集 / manifest —— 请先在「数据」页配置渲染组并确认 ingest 已生成 meta/manifest.json。</p>';
      return;
    }
    const rep = this.aggregate();
    const t = rep.totals;
    const fmtNum = (n) => (n == null ? "—" : n);

    const card = (label, val, cls) =>
      `<div class="rep-card ${cls}"><div class="rep-card-val">${val}</div><div class="rep-card-label">${label}</div></div>`;
    const cards =
      `<div class="rep-cards">
        ${card("Deck 总数", t.decks)}
        ${card("已标注", t.annotated, "ok")}
        ${card("已提交", t.submitted, "ok")}
        ${card("草稿", t.draft, "warn")}
        ${card("待标注", t.decks - t.annotated)}
      </div>`;

    const dsRows = rep.datasets.map((d) => {
      const st = d.score;
      return `<tr>
        <th>${escapeHtml(d.name)}</th>
        <td>${d.annotated} / ${d.decks}</td>
        <td class="ok">${d.best}</td>
        <td class="err">${d.worst}</td>
        <td>${fmtNum(st.mean)}</td>
        <td>${fmtNum(st.median)}</td>
        <td>${fmtNum(st.variance)}</td>
        <td>${fmtNum(st.stddev)}</td>
        <td><div class="rep-bars">${this.bars(st.distribution)}</div></td>
      </tr>`;
    }).join("");

    const deckRows = rep.decks.map((d) => {
      const status = d.annotated
        ? (d.status === "submitted" ? '<span class="ok">已提交</span>' : '<span class="warn">草稿</span>')
        : '<span class="muted">未标注</span>';
      const cells = d.versions.map((v) => {
        let s = v.score == null ? '<span class="muted">-</span>' : escapeHtml(String(v.score));
        if (v.rank === "best") s = `<span class="rank-best">${s} ★</span>`;
        else if (v.rank === "worst") s = `<span class="rank-worst">${s} ✗</span>`;
        return `<td>${s}</td>`;
      }).join("");
      return `<tr>
        <th><a href="#" class="deck-link" data-deck="${d.id}" title="打开该 Deck 复查">${escapeHtml(d.name)}</a></th>
        <td>${status}</td>
        <td>${d.updated_at ? escapeHtml(d.updated_at.slice(0, 19)) : ""}</td>
        ${cells}
      </tr>`;
    }).join("");
    const thScores = datasets.map((d) => `<th>${escapeHtml(d.name)}</th>`).join("");

    box.innerHTML =
      `${cards}
      <h3>数据源汇总</h3>
      <div class="rep-table-wrap"><table class="rep-table">
        <thead><tr><th>数据源</th><th>已标/总数</th><th>最佳</th><th>最差</th><th>均值</th><th>中位数</th><th>方差</th><th>标准差</th><th>分数分布</th></tr></thead>
        <tbody>${dsRows}</tbody>
      </table></div>
      <h3>逐 Deck 明细</h3>
      <div class="rep-table-wrap"><table class="rep-table">
        <thead><tr><th>Deck</th><th>状态</th><th>更新时间</th>${thScores}</tr></thead>
        <tbody>${deckRows}</tbody>
      </table></div>
      <p class="rep-hint muted">完整离线报告（HTML / CSV / JSON）由 <code>python scripts/report.py</code> 生成到 <code>reports/</code>；HTML 内含柱状图与回链，点击 Deck 名可跳回标注页复查。</p>`;

    box.querySelectorAll(".deck-link").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        App.openDeck(Number(a.dataset.deck));
      }));
  },

  /* 把当前聚合导出为自包含静态网页 report.html（下载，无 CDN / 无依赖） */
  exportHTML() {
    const rep = this.aggregate();
    const blob = new Blob([this.toHTML(rep)], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "report.html";
    a.click();
    URL.revokeObjectURL(a.href);
    OpLog.add("导出报告 HTML");
  },

  /* 自包含 HTML（内联 CSS 柱状图 + 回链），与 scripts/report.py 的 format_html 同口径 */
  toHTML(rep) {
    const t = rep.totals;
    const fmtNum = (n) => (n == null ? "—" : n);
    const card = (l, v, cls) => `<div class="card ${cls}"><div class="val">${v}</div><div class="lbl">${l}</div></div>`;
    const cards =
      `<div class="cards">
        ${card("Deck 总数", t.decks)}
        ${card("已标注", t.annotated, "ok")}
        ${card("已提交", t.submitted, "ok")}
        ${card("草稿", t.draft, "warn")}
        ${card("待标注", t.decks - t.annotated)}
      </div>`;

    const dsRows = rep.datasets.map((d) => {
      const st = d.score;
      return `<tr>
        <th>${escapeHtml(d.name)}</th>
        <td>${d.annotated} / ${d.decks}</td>
        <td class="ok">${d.best}</td>
        <td class="err">${d.worst}</td>
        <td>${fmtNum(st.mean)}</td>
        <td>${fmtNum(st.median)}</td>
        <td>${fmtNum(st.variance)}</td>
        <td>${fmtNum(st.stddev)}</td>
        <td><div class="rep-bars">${this.bars(st.distribution)}</div></td>
      </tr>`;
    }).join("");

    const deckRows = rep.decks.map((d) => {
      const status = d.annotated
        ? (d.status === "submitted" ? '<span class="ok">已提交</span>' : '<span class="warn">草稿</span>')
        : '<span class="muted">未标注</span>';
      const cells = d.versions.map((v) => {
        let s = v.score == null ? '<span class="muted">-</span>' : escapeHtml(String(v.score));
        if (v.rank === "best") s = `<span class="rank-best">${s} ★</span>`;
        else if (v.rank === "worst") s = `<span class="rank-worst">${s} ✗</span>`;
        return `<td>${s}</td>`;
      }).join("");
      return `<tr>
        <th><a href="index.html#/deck/${d.id}">${escapeHtml(d.name)}</a></th>
        <td>${status}</td>
        <td>${d.updated_at ? escapeHtml(d.updated_at.slice(0, 19)) : ""}</td>
        ${cells}
      </tr>`;
    }).join("");
    const thScores = rep.datasets.map((d) => `<th>${escapeHtml(d.name)}</th>`).join("");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PPT 盲测标注报告</title>
<style>${this._EXPORT_CSS}</style>
</head>
<body>
<h1>PPT 盲测标注报告</h1>
<p class="meta">生成时间：${escapeHtml(rep.generated_at)} · Deck 总数 ${t.decks} · 已标注 ${t.annotated}</p>
${cards}

<h2>数据源汇总</h2>
<div class="wrap"><table>
<thead><tr><th>数据源</th><th>已标/总数</th><th>最佳</th><th>最差</th><th>均值</th><th>中位数</th><th>方差</th><th>标准差</th><th>分数分布</th></tr></thead>
<tbody>${dsRows}</tbody>
</table></div>

<h2>逐 Deck 明细</h2>
<div class="wrap"><table>
<thead><tr><th>Deck</th><th>状态</th><th>更新时间</th>${thScores}</tr></thead>
<tbody>${deckRows}</tbody>
</table></div>

<footer>导出自 PPT 盲测对照标注平台 · 点击 Deck 名可回链标注页（需在应用内打开，回链为 <code>index.html#/deck/&lt;id&gt;</code>）。</footer>
</body>
</html>`;
  },

  /* 导出 HTML 的内联 CSS（离线可打开） */
  _EXPORT_CSS: `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; color: #1f2328; background: #fff; line-height: 1.5; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 10px; border-bottom: 1px solid #e6e9ee; padding-bottom: 6px; }
.meta { color: #8a8f98; font-size: 12px; margin: 0 0 18px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 16px 0; }
.card { background: #f1f4f8; border: 1px solid #e6e9ee; border-radius: 8px; padding: 12px 14px; }
.card .val { font-size: 22px; font-weight: 700; }
.card .lbl { font-size: 11px; color: #8a8f98; margin-top: 2px; }
.card.ok .val { color: #1a7f37; }
.card.warn .val { color: #9a6700; }
table { border-collapse: collapse; width: 100%; min-width: max-content; margin-top: 8px; }
th, td { padding: 6px 12px; text-align: center; border-bottom: 1px solid #e6e9ee; white-space: nowrap; font-size: 13px; }
thead th { position: sticky; top: 0; background: #f1f4f8; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
tbody th { background: #f1f4f8; font-weight: 600; }
.wrap { background: #f1f4f8; border: 1px solid #e6e9ee; border-radius: 8px; overflow: auto; }
.ok { color: #1a7f37; } .warn { color: #9a6700; } .err { color: #cf222e; } .muted { color: #8a8f98; }
a { color: #007acc; text-decoration: none; } a:hover { text-decoration: underline; }
.rank-best { color: #1a7f37; font-weight: 600; }
.rank-worst { color: #cf222e; font-weight: 600; }
.rep-bars { display: inline-flex; align-items: flex-end; gap: 4px; height: 44px; }
.rep-bar { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; width: 24px; height: 100%; }
.rep-bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.rep-bar-fill { width: 100%; background: #007acc; border-radius: 2px 2px 0 0; min-height: 2px; }
.rep-bar-val { font-size: 10px; line-height: 1; }
.rep-bar-label { font-size: 10px; color: #8a8f98; line-height: 1.2; }
footer { margin-top: 32px; color: #8a8f98; font-size: 11px; }
code { background: rgba(0,0,0,0.05); padding: 0 4px; border-radius: 4px; font-size: 12px; }
`,
};
