/* File System Access API 封装（Chromium/Edge）。
   职责：授权 data/ 目录（IndexedDB 记住）、读 JSON、原子写、追加 jsonl。 */
const FS = (() => {
  const DB_NAME = "ppt-annotator";
  const STORE = "handles";
  let dirHandle = null;

  function idb() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("indexedDB 超时")); }
      }, 2000);
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(req.result); } };
        req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error); } };
        req.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("indexedDB 被阻塞")); } };
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  async function storeHandle(h) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(h, "data");
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error("abort"));
      });
    } catch (_) {
      /* 记住句柄失败不致命：本次会话仍可用，只是下次需重选目录 */
    }
  }

  async function loadStoredHandle() {
    try {
      const db = await idb();
      return await new Promise((res) => {
        const tx = db.transaction(STORE, "readonly");
        const r = tx.objectStore(STORE).get("data");
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      });
    } catch (_) { return null; }
  }

  function hasSupport() {
    return typeof window.showDirectoryPicker === "function";
  }

  /* 选择目录后立即请求读写权限：showDirectoryPicker 只给读权限，写文件（getFileHandle create）
     需要 readwrite；在此处（用户手势内）授权后，后续写入不再依赖每次调用的用户激活。 */
  async function grantWrite(h) {
    try { await h.requestPermission({ mode: "readwrite" }); } catch (_) { /* 失败则写入时按需再请求 */ }
    return h;
  }

  async function requestAccess() {
    const h = await window.showDirectoryPicker();
    await grantWrite(h);
    dirHandle = h;
    await storeHandle(h);
    return h;
  }

  /* 强制重新选择目录：弹出文件选择框；若用户取消则保留原目录（返回 null，不报错、不改界面） */
  async function reSelect() {
    let h;
    try { h = await window.showDirectoryPicker(); }
    catch (_) { return null; }
    await grantWrite(h);
    dirHandle = h;
    await storeHandle(h);
    return h;
  }

  /* 静默恢复已保存的目录句柄（不弹窗、不请求权限；读取失败由上层处理） */
  async function tryRestore() {
    if (dirHandle) return dirHandle;
    let h = null;
    try { h = await loadStoredHandle(); } catch (_) { /* ignore */ }
    if (h) dirHandle = h;
    return h;
  }

  /* 确保当前目录句柄具备读写权限（在用户手势内调用；已授权则立即返回 true）。
     用于「提交修改」等会在中途弹 prompt 的操作：先在此处授权，避免 prompt 后 getFileHandle 因失去用户激活而失败。 */
  async function ensureWritePermission() {
    let h = dirHandle;
    try { if (!h) h = await tryRestore(); } catch (_) { /* ignore */ }
    if (!h) return false;
    try {
      const perm = await h.queryPermission({ mode: "readwrite" });
      if (perm === "granted") return true;
      if (perm === "prompt") {
        const req = await h.requestPermission({ mode: "readwrite" });
        return req === "granted";
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /* 获取 data/ 目录句柄；prompt=false 时不弹窗（静默，用于后台轮询失败恢复） */
  async function getHandle({ prompt = true } = {}) {
    if (dirHandle) return dirHandle;
    let h = null;
    try { h = await loadStoredHandle(); } catch (_) { /* ignore */ }
    if (h) {
      try {
        const perm = await h.queryPermission({ mode: "readwrite" });
        if (perm === "granted") { dirHandle = h; return h; }
        if (perm === "prompt" && prompt) {
          const req = await h.requestPermission({ mode: "readwrite" });
          if (req === "granted") { dirHandle = h; return h; }
        }
      } catch (_) { /* permission API 不可用则重新选择 */ }
    }
    if (prompt) return requestAccess();
    return null;
  }

  /* 读取文件文本：name 支持嵌套路径（如 "meta/manifest.json"），
     Chrome 的 getFileHandle 只接受单层名，需逐级进入子目录。 */
  async function readFileText(name) {
    const parts = String(name).split("/");
    let dh = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dh = await dh.getDirectoryHandle(parts[i]);
    }
    const fh = await dh.getFileHandle(parts[parts.length - 1]);
    const f = await fh.getFile();
    return f.text();
  }

  async function readJSON(name) {
    try { return JSON.parse(await readFileText(name)); } catch (_) { return null; }
  }

  /* 读取相对所选 data 目录的图片并返回 Blob URL。用目录句柄读，任意路径都可用，
     不依赖页面位置或固定的 data/ 目录名。结果按路径缓存；文件重渲染后调用 clearUrlCache() 刷新。 */
  const _urlCache = new Map();
  async function fileUrl(relPath) {
    if (_urlCache.has(relPath)) return _urlCache.get(relPath);
    const parts = String(relPath).split("/").filter(Boolean);
    let dh = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) dh = await dh.getDirectoryHandle(parts[i]);
    const fh = await dh.getFileHandle(parts[parts.length - 1]);
    const f = await fh.getFile();
    const url = URL.createObjectURL(f);
    _urlCache.set(relPath, url);
    return url;
  }
  function clearUrlCache() {
    _urlCache.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } });
    _urlCache.clear();
  }

  /* 原子写：优先 tmp+move（读者永远看到旧或新的完整文件）。
     move 偶尔因目标被外部进程占用（如 ingest --watch 正读 config.json）失败，短暂重试；
     仍失败才退回直接截断写（非原子，但后端读端已做重试+跳过容错）。写完清理 tmp 残留。 */
  async function writeJSONAtomic(name, obj) {
    const text = JSON.stringify(obj, null, 2) + "\n";
    const tmpName = name + ".tmp";
    let wrote = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tmpHandle = await dirHandle.getFileHandle(tmpName, { create: true });
        const w = await tmpHandle.createWritable();
        try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
        await tmpHandle.move(name);
        wrote = true;
        break;
      } catch (_) {
        if (attempt < 2) await new Promise(r => setTimeout(r, 80));
      }
    }
    if (!wrote) {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try { await w.write(text); await w.close(); } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
    }
    try { await dirHandle.removeEntry(tmpName); } catch (_) { /* tmp 已被 move 消耗则忽略 */ }
  }

  async function appendLine(name, line) {
    // 快速追加：不重读整个文件，直接 seek 到末尾写入
    const h = await dirHandle.getFileHandle(name, { create: true });
    const size = (await h.getFile()).size;
    const w = await h.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(line + "\n");
    await w.close();
  }

  /* 列出相对路径目录下的条目（{name, kind}），目录优先、按名排序（文件夹树用） */
  async function listDir(relPath) {
    let dh = dirHandle;
    const parts = relPath ? String(relPath).split("/").filter(Boolean) : [];
    for (const p of parts) dh = await dh.getDirectoryHandle(p);
    const out = [];
    for await (const [k, v] of dh.entries()) out.push({ name: k, kind: v.kind });
    out.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === "directory" ? -1 : 1));
    return out;
  }

  /* 递归扫描 data/ 树下「直接包含 pptx/ppt 文件的目录」，返回相对路径（如 "demo/methodA"）。
     用于 config 为空（全部取消渲染）时仍能列出可加回的数据源；跳过 meta/、rendered/。 */
  async function findSourceDirs(maxDepth = 4) {
    const out = [];
    const queue = [""];
    while (queue.length) {
      const cur = queue.shift();
      const depth = cur ? cur.split("/").length : 0;
      if (depth > maxDepth) continue;
      let entries;
      try { entries = await listDir(cur); } catch (_) { continue; }
      let hasPptx = false;
      for (const e of entries) {
        if (e.kind === "directory") {
          if (e.name === "meta" || e.name === "rendered") continue;
          queue.push(cur ? cur + "/" + e.name : e.name);
        } else if (/\.(pptx|ppt)$/i.test(e.name)) {
          hasPptx = true;
        }
      }
      if (hasPptx) out.push(cur);
    }
    return out;
  }

  /* 确保相对路径目录存在（逐级创建），返回最后目录句柄（添加数据集用） */
  async function ensureDir(relPath) {
    let dh = dirHandle;
    const parts = String(relPath).split("/").filter(Boolean);
    for (const p of parts) dh = await dh.getDirectoryHandle(p, { create: true });
    return dh;
  }

  /* 删除相对路径的目录（含其内容） */
  async function removeDir(relPath) {
    const parts = String(relPath).split("/").filter(Boolean);
    const name = parts.pop();
    let dh = dirHandle;
    for (const p of parts) dh = await dh.getDirectoryHandle(p);
    await dh.removeEntry(name, { recursive: true });
  }

  /* ---- 本地配置桥接（launch.py 起的极简 HTTP 端点）----
     前端无法直接写工作区文件（只拿到被打开目录的句柄），经 GET/PUT /config
     把「外部目录 config」复制到工作区 data/config.json（ingest 始终监听它）。
     未以 launch.py 启动（无 ?bridge= 参数）时全部返回空/失败，功能自动降级。 */
  function bridgeBase() {
    try {
      // launch.py 经桥接同源伺服前端时：直接用当前 origin（无 CORS / 参数丢失问题）
      if (location.protocol === "http:" || location.protocol === "https:") {
        return location.origin;
      }
      // file:// 直开时：靠 launch.py 附加的 ?bridge= 端口定位
      const p = new URLSearchParams(location.search).get("bridge");
      return p ? `http://127.0.0.1:${p}` : null;
    } catch (_) { return null; }
  }

  async function bridgeGetConfig() {
    const base = bridgeBase();
    if (!base) return null;
    try {
      const r = await fetch(base + "/config");
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  async function bridgePutConfig(cfg) {
    const base = bridgeBase();
    if (!base) return false;
    try {
      const r = await fetch(base + "/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      return r.ok;
    } catch (_) { return false; }
  }

  /* 诊断信息：当前选中目录名 + 是否含关键文件 + 顶层条目列表。
     注：浏览器隐私限制，无法拿到绝对路径，只能拿到目录名（FileSystemHandle.name）。 */
  async function dirInfo() {
    const info = { name: "", hasMeta: false, hasConfig: false, top: [] };
    const h = dirHandle || (await tryRestore());
    if (!h) return info;
    info.name = h.name || "";
    try {
      const entries = [];
      for await (const [k, v] of h.entries()) {
        entries.push(v.kind === "directory" ? k + "/" : k);
      }
      info.top = entries.sort();
    } catch (_) { /* ignore */ }
    try { await readFileText("meta/manifest.json"); info.hasMeta = true; } catch (_) { /* missing */ }
    try { await readFileText("config.json"); info.hasConfig = true; } catch (_) { /* missing */ }
    return info;
  }

  return { hasSupport, getHandle, tryRestore, reSelect, ensureWritePermission, readJSON, readFileText, fileUrl, clearUrlCache, writeJSONAtomic, appendLine, dirInfo, listDir, findSourceDirs, ensureDir, removeDir, bridgeBase, bridgeGetConfig, bridgePutConfig };
})();
