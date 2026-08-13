/* 报告视图（M3 实现）。 */
const Report = {
  render() {
    const box = document.getElementById("report-box");
    box.innerHTML =
      '<p class="muted">报告生成将在 M3 实现：<code>python scripts/report.py</code> → ' +
      "<code>reports/</code>（HTML / CSV / JSON）。</p>";
  },
};
