"""
CyberHistoryExplorer — FastAPI 主入口与路由服务
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import List, Optional
from pathlib import Path

from fastapi import FastAPI, Query, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import database
import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CyberHistory")

# --- Pydantic Models ---

class VideoMeta(BaseModel):
    videoId: str
    title: str = ""
    channel: str = ""
    url: Optional[str] = None
    duration_sec: int = 0
    thumbnail: Optional[str] = None
    watchedDate: str = ""
    seq_order: int = 0

class SyncRequest(BaseModel):
    items: List[VideoMeta]

# --- Background Worker ---

worker_task: Optional[asyncio.Task] = None

async def pipeline_worker():
    """后台串行处理 pending 项目（字幕抓取/ASR）"""
    from pipeline import process_item
    logger.info("Pipeline worker started")
    while True:
        try:
            item = database.get_next_pending_item()
            if item:
                logger.info(f"Processing: [{item['source_id']}] {item['title']}")
                database.update_item_status(item["id"], "processing", current_step="准备处理", progress_pct=5)
                try:
                    await asyncio.get_event_loop().run_in_executor(None, process_item, item)
                except Exception as e:
                    logger.error(f"Failed to process {item['source_id']}: {e}")
                    database.update_item_status(item["id"], "failed", str(e))
                # 防风控延迟
                await asyncio.sleep(3)
            else:
                await asyncio.sleep(10)
        except Exception as e:
            logger.error(f"Worker loop error: {e}")
            await asyncio.sleep(10)

# --- Lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    logger.info(f"Database initialized at {config.DB_PATH}")
    global worker_task
    worker_task = asyncio.create_task(pipeline_worker())
    logger.info(f"CyberHistoryExplorer running at http://{config.HOST}:{config.PORT}")
    yield
    if worker_task:
        worker_task.cancel()

# --- App ---

app = FastAPI(title="cyberstory", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_private_network_headers(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

# userscript 文件直链 (方便油猴一键安装与更新)
userscript_file = Path(__file__).resolve().parent / "userscript" / "youtube-history-sync.user.js"

@app.get("/userscript/youtube-history-sync.user.js")
async def get_userscript():
    if userscript_file.exists():
        return FileResponse(str(userscript_file), media_type="text/javascript")
    raise HTTPException(status_code=404, detail="Userscript not found")

# 静态文件
static_dir = Path(__file__).resolve().parent / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def index():
    index_file = static_dir / "index.html"
    if index_file.exists():
        return FileResponse(str(index_file))
    return HTMLResponse("<h1>CyberHistoryExplorer</h1><p>static/index.html not found</p>")

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "cyberstory"}

@app.get("/api/sync/latest_cursor")
async def latest_cursor():
    """获取服务端历史流水中的最后一条记录 (最新观看) 作为分界线游标"""
    cursor_item = database.get_latest_cursor()
    if cursor_item:
        return {
            "has_cursor": True,
            "cursor_id": cursor_item["source_id"],
            "item_id": cursor_item["id"],
            "title": cursor_item["title"],
            "watched_at": cursor_item.get("watched_at", "")
        }
    return {"has_cursor": False, "cursor_id": None}

@app.post("/api/sync/youtube")
async def sync_youtube(req: SyncRequest):
    items_data = [item.model_dump() for item in req.items]
    result = database.insert_items(items_data)
    logger.info(f"Sync received: inserted={result['inserted']}")
    return {"success": True, **result}

@app.get("/api/search")
async def search_api(
    q: str = Query(..., min_length=1, description="搜索关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    source: Optional[str] = Query(None, description="数据源: all, youtube, zhihu")
):
    result = database.search(q, page, page_size, source)
    return result

@app.get("/api/items/{item_id}/subtitles")
async def item_subtitles(item_id: int):
    subtitles = database.get_item_subtitles(item_id)
    return {"item_id": item_id, "subtitles": subtitles}

@app.get("/api/history")
async def history_feed():
    """获取按日期分组的历史记录列表，包含状态、进度与耗时"""
    return database.get_history_feed()

@app.get("/api/status")
async def status():
    stats = database.get_stats()
    return stats

# --- Entry Point ---

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=config.HOST, port=config.PORT, reload=False, log_level="info")
