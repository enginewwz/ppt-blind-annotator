"""本地配置桥接：极简 HTTP 端点，读写工作区根目录的跟踪配置 watched/config.json，
并同源伺服前端静态页（http://127.0.0.1:<port>/index.html）。

前端无法直接写工作区文件（浏览器只拿到被打开目录的句柄，且隐私限制拿不到绝对路径），
经此端点把「外部目录 config」复制到工作区 watched/config.json；ingest --watch 检测到
变化即开始渲染。launch.py 以「本进程内线程」运行本服务器。

同源伺服前端后，fetch /config 不再跨源 → Windows/file:// 下的 CORS 与 ?bridge= 参数丢失
问题消失。只监听 127.0.0.1。

用法：python -m scripts.bridge [--port 8765]
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import paths  # noqa: E402
from scripts.atomic import atomic_write_json  # noqa: E402


def _make_handler(cfg_path: Path) -> type[BaseHTTPRequestHandler]:
    class _Handler(BaseHTTPRequestHandler):
        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _json(self, code: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _serve_static(self) -> None:
            """同源伺服前端静态页：/ → index.html，其余映射到 app/static 下对应文件。"""
            path = self.path.split("?", 1)[0]
            if path in ("", "/"):
                path = "/index.html"
            target = (paths.STATIC_DIR / path.lstrip("/")).resolve()
            try:
                target.relative_to(paths.STATIC_DIR.resolve())
            except ValueError:
                return self._json(404, {"error": "not found"})
            if not target.is_file():
                return self._json(404, {"error": "not found"})
            body = target.read_bytes()
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path.split("?", 1)[0] == "/config":
                if not cfg_path.is_file():
                    return self._json(404, {"error": "no config"})
                with open(cfg_path, encoding="utf-8") as f:
                    return self._json(200, json.load(f))
            self._serve_static()

        def do_PUT(self) -> None:
            if self.path.split("?")[0] != "/config":
                return self._json(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", 0))
                cfg = json.loads(self.rfile.read(n))
            except Exception:  # noqa: BLE001
                return self._json(400, {"error": "bad json"})
            cfg_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_json(cfg_path, cfg)
            self._json(200, {"ok": True})

        def log_message(self, *args):  # 静默，不刷屏
            pass

    return _Handler


def create_server(port: int) -> ThreadingHTTPServer:
    """创建并绑定桥接服务器。绑定失败在此处抛 OSError，便于调用方提示「端口被占用」。"""
    return ThreadingHTTPServer(("127.0.0.1", port), _make_handler(paths.WATCH_CONFIG_PATH))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本地配置桥接（前端 ↔ 工作区 config）")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    args = parser.parse_args(argv)

    server = create_server(args.port)
    print(f"[bridge] 监听 http://127.0.0.1:{args.port}/config（Ctrl+C 停止）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
