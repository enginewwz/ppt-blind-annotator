"""M1 渲染管线：pptx ->(soffice headless)-> pdf ->(PyMuPDF)-> 每页像素 ->(Pillow)-> WebP 全图 + 缩略图。

注意：soffice 的 `--convert-to png` 对 pptx 只导出第一页，必须走 pdf 中间产物。
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def src_key(path: Path) -> str:
    """断点续跑缓存键：文件大小 + mtime（纳秒）。"""
    st = path.stat()
    return f"{st.st_size}:{st.st_mtime_ns}"


def find_soffice(name: str = "soffice") -> str:
    p = shutil.which(name) or shutil.which("libreoffice")
    if not p:
        raise FileNotFoundError(
            f"找不到 LibreOffice（{name}），请安装 libreoffice-impress"
        )
    return p


def convert_pptx_to_pdf(soffice: str, file_path: Path, outdir: Path, profile_dir: Path) -> Path:
    """soffice headless 转 pdf（独立用户目录避免多进程冲突）。返回生成的 pdf 路径。"""
    profile_uri = profile_dir.as_uri()
    cmd = [
        soffice,
        f"-env:UserInstallation={profile_uri}",
        "--headless", "--norestore", "--nofirststartwizard",
        "--convert-to", "pdf", "--outdir", str(outdir), str(file_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(
            f"soffice 转换失败 (rc={proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    pdf = outdir / (file_path.stem + ".pdf")
    if not pdf.is_file():
        raise RuntimeError(f"soffice 未生成 pdf: {pdf}")
    return pdf


def render_pdf_to_webp(pdf_path: Path, out_dir: Path, dpi: int, thumb_width: int) -> list[dict[str, Any]]:
    """逐页渲染：WebP 全图 + 缩略图。返回 pages（src/thumb 为绝对路径）。"""
    import pymupdf
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    pages: list[dict[str, Any]] = []
    doc = pymupdf.open(pdf_path)
    try:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=dpi)
            mode = "RGBA" if pix.alpha else "RGB"
            img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
            if mode == "RGBA":
                img = img.convert("RGB")
            w, h = img.size
            full = out_dir / f"page_{i:03d}.webp"
            img.save(full, "WEBP", quality=85, method=6)
            thumb = img.copy()
            thumb.thumbnail((thumb_width, 100_000))
            thumb_path = out_dir / f"thumb_{i:03d}.webp"
            thumb.save(thumb_path, "WEBP", quality=80, method=6)
            img.close()
            thumb.close()
            pages.append({"src": str(full), "thumb": str(thumb_path), "w": w, "h": h})
    finally:
        doc.close()
    return pages


def _commit_staged_pages(stage: Path, out_dir: Path, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把 staging 里渲染好的页面搬入最终目录：先搬入新文件（保证清单引用的文件一定存在），
    再删除不再需要的旧页，避免留下半成品/碎片文件。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    final = []
    for p in pages:
        final_src = out_dir / Path(p["src"]).name
        final_thumb = out_dir / Path(p["thumb"]).name
        shutil.move(p["src"], final_src)
        shutil.move(p["thumb"], final_thumb)
        final.append({"src": str(final_src), "thumb": str(final_thumb), "w": p["w"], "h": p["h"]})
    wanted = {Path(p["src"]).name for p in pages} | {Path(p["thumb"]).name for p in pages}
    for old in list(out_dir.glob("page_*.webp")) + list(out_dir.glob("thumb_*.webp")):
        if old.name not in wanted:
            old.unlink(missing_ok=True)
    return final


def render_version(args: dict) -> dict:
    """Worker：渲染单个 pptx 版本（独立 LO 用户目录，任务结束清理）。

    先渲染到临时 staging 目录，全部成功才搬入最终目录；失败时 staging 随上下文自动清理，
    绝不留下半成品页文件。返回: {"ok": bool, "pages": [...], "page_count": int, "error": str?}
    """
    file_path = Path(args["file_path"])
    out_dir = Path(args["out_dir"])
    dpi = int(args.get("dpi", 150))
    thumb_width = int(args.get("thumb_width", 360))
    soffice = args.get("soffice") or "soffice"
    if not file_path.is_file():
        return {"ok": False, "error": f"文件不存在: {file_path}"}
    try:
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        profile_dir = Path(tempfile.mkdtemp(prefix="lo_profile_"))
        try:
            with tempfile.TemporaryDirectory(prefix="pdf_tmp_") as tmp:
                pdf = convert_pptx_to_pdf(soffice, file_path, Path(tmp), profile_dir)
                with tempfile.TemporaryDirectory(prefix="stage_", dir=str(out_dir.parent)) as stage:
                    pages = render_pdf_to_webp(pdf, Path(stage), dpi, thumb_width)
                    pages = _commit_staged_pages(Path(stage), out_dir, pages)
        finally:
            shutil.rmtree(profile_dir, ignore_errors=True)
        return {"ok": True, "pages": pages, "page_count": len(pages)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
