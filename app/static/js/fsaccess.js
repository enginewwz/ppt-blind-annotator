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

  async function requestAccess() {
    dirHandle = await window.showDirectoryPicker();
    await storeHandle(dirHandle);
    return dirHandle;
  }

  /* 强制重新选择目录：弹出文件选择框；若用户取消则保留原目录（返回 null，不报错、不改界面） */
  async function reSelect() {
    let h;
    try { h = await window.showDirectoryPicker(); }
    catch (_) { return null; }
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

  /* 原子写：写临时文件后 move 覆盖（FS Access 不支持 os.replace，用 move 近似） */
  async function writeJSONAtomic(name, obj) {
    const text = JSON.stringify(obj, null, 2) + "\n";
    const tmpName = name + ".tmp";
    const tmpHandle = await dirHandle.getFileHandle(tmpName, { create: true });
    const w = await tmpHandle.createWritable();
    try { await w.write(text); await w.close(); } catch (e) { await w.abort(); throw e; }
    await tmpHandle.move(name);
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

  return { hasSupport, getHandle, tryRestore, reSelect, readJSON, readFileText, writeJSONAtomic, appendLine, dirInfo, listDir };
})();
