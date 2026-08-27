"""Deck / 版本的渲染状态常量。"""

STATUS_PENDING = "pending"      # 尚未渲染
STATUS_RENDERING = "rendering"  # 正在渲染
STATUS_READY = "ready"          # 渲染完成，可标注
STATUS_FAILED = "failed"        # 渲染失败

ALL_STATUSES = (STATUS_PENDING, STATUS_RENDERING, STATUS_READY, STATUS_FAILED)
