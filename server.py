"""
CyberHistoryExplorer — FastAPI 主入口与路由服务
"""
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import List, Optional, Dict, Any
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
    ts_id: Optional[int] = None
    videoId: str
    title: str = ""
    channel: str = ""
    url: Optional[str] = None
    duration_sec: int = 0
    thumbnail: Optional[str] = None
    watchedDate: str = ""

class SyncRequest(BaseModel):
    items: List[VideoMeta]

# --- Background Multi-Workers (解耦音频下载 worker 与 ASR worker) ---

pipeline_running: bool = True
download_worker_task: Optional[asyncio.Task] = None
asr_worker_task: Optional[asyncio.Task] = None

def run_download_job(item: Dict[str, Any]):
    """下载 Worker 任务函数：首先尝试抓取原生字幕，若无则检查背压缓冲区，未超限则拉取音频并将状态流转至 audio_ready"""
    from pipeline import try_fetch_subtitles, download_audio_file
    source_id = item["source_id"]
    item_id = item.get("ts_id") or item["id"]
    t0 = time.time()

    database.update_item_status(item_id, status="downloading", current_step="检测字幕", progress_pct=15)

    # 1. 优先尝试原生字幕 (文本字幕无需占用音频缓冲池)
    segments = try_fetch_subtitles(source_id)
    if segments:
        cost = time.time() - t0
        logger.info(f"[{source_id}] Download worker got subtitles: {len(segments)} segments in {cost:.1f}s")
        database.save_subtitles_and_index(item_id, segments, "native", cost_time_sec=cost)
        return

    # 2. 检查背压 (Backpressure)：当前音频缓冲池是否超过上限 (默认 500 MB)
    max_cache_bytes = getattr(config, "MAX_AUDIO_CACHE_MB", 500) * 1024 * 1024
    current_cache_bytes = database.get_audio_cache_bytes()
    if current_cache_bytes >= max_cache_bytes:
        cur_mb = current_cache_bytes / (1024 * 1024)
        logger.info(f"[Backpressure] Audio cache full ({cur_mb:.1f}MB >= {config.MAX_AUDIO_CACHE_MB}MB), pausing download worker")
        database.update_item_status(item_id, status="pending", current_step="等待音频缓冲释放(500MB限额)", progress_pct=0)
        return

    # 3. 缓冲区未超额，执行音频下载
    database.update_item_status(item_id, status="downloading", current_step="音频下载中", progress_pct=30)
    audio_path = download_audio_file(source_id, item_id=item_id, t0=t0)
    cost = time.time() - t0

    if audio_path and audio_path.exists():
        logger.info(f"[{source_id}] Audio downloaded in {cost:.1f}s, transitioning to audio_ready")
        database.update_item_status(item_id, status="audio_ready", current_step="音频就绪待转写", progress_pct=35, cost_time_sec=cost)
    else:
        logger.warning(f"[{source_id}] Audio download failed, keeping as pending for retry")
        database.update_item_status(item_id, status="pending", current_step="下载未成功(重试排队)", progress_pct=0, cost_time_sec=cost)


def run_asr_job(item: Dict[str, Any]):
    """ASR Worker 任务函数：从 audio_ready 任务池取走音频进行 Whisper 转录，完成后强制删除本地音频文件"""
    from pipeline import transcribe_audio_file
    source_id = item["source_id"]
    item_id = item.get("ts_id") or item["id"]
    t0 = time.time() - float(item.get("cost_time_sec") or 0.0)

    audio_dir = config.TEMP_DIR / "audio"
    audio_files = list(audio_dir.glob(f"{source_id}.*"))
    if not audio_files:
        logger.warning(f"[{source_id}] Audio file missing for ASR, re-marking as pending")
        database.update_item_status(item_id, status="pending", current_step="等待重新下载", progress_pct=0)
        return

    audio_path = audio_files[0]
    database.update_item_status(item_id, status="transcribing", current_step="Whisper模型加载", progress_pct=40)

    try:
        segments = transcribe_audio_file(audio_path, source_id, item_id=item_id, t0=t0)
        cost = time.time() - t0
        if segments:
            logger.info(f"[{source_id}] ASR worker completed: {len(segments)} segments in {cost:.1f}s")
            database.save_subtitles_and_index(item_id, segments, "asr", cost_time_sec=cost)
        else:
            logger.warning(f"[{source_id}] ASR produced no segments, re-queueing as pending")
            database.update_item_status(item_id, status="pending", current_step="待重新识别", progress_pct=0, cost_time_sec=cost)
    except Exception as e:
        logger.error(f"[{source_id}] ASR worker failed: {e}")
        database.update_item_status(item_id, status="pending", current_step="识别异常(等待重试)", progress_pct=0, error_message=str(e))
    finally:
        # 确保音频文件被彻底删除
        try:
            if audio_path.exists():
                audio_path.unlink(missing_ok=True)
                logger.info(f"Cleaned up audio file: {audio_path.name}")
        except Exception:
            pass


async def download_worker():
    """Worker 1: 专用音频下载与字幕提取，高 I/O 并发（内置 500MB 磁盘背压限流）"""
    logger.info("Download worker started")
    while True:
        try:
            if not pipeline_running:
                await asyncio.sleep(2)
                continue

            # 背压限流检测：当前音频池达到 500MB 时，暂停拉取新音频，放缓轮询等待 ASRWorker 消费
            max_cache_bytes = getattr(config, "MAX_AUDIO_CACHE_MB", 500) * 1024 * 1024
            if database.get_audio_cache_bytes() >= max_cache_bytes:
                await asyncio.sleep(5)
                continue

            item = database.get_next_pending_item()
            if item:
                logger.info(f"[DownloadWorker] Picked [{item['source_id']}] {item['title'][:30]}")
                try:
                    await asyncio.get_event_loop().run_in_executor(None, run_download_job, item)
                except Exception as e:
                    logger.error(f"[DownloadWorker] Failed {item['source_id']}: {e}")
                    database.update_item_status(item["id"], "pending", str(e))
                await asyncio.sleep(2)
            else:
                await asyncio.sleep(6)
        except Exception as e:
            logger.error(f"[DownloadWorker] Loop error: {e}")
            await asyncio.sleep(6)


async def asr_worker():
    """Worker 2: 专用 faster-whisper ASR 转写，独立调度，CPU 受控"""
    logger.info("ASR worker started")
    while True:
        try:
            if not pipeline_running:
                await asyncio.sleep(2)
                continue

            item = database.get_next_audio_ready_item()
            if item:
                logger.info(f"[ASRWorker] Picked [{item['source_id']}] {item['title'][:30]}")
                database.update_item_status(item["id"], status="transcribing", current_step="Whisper模型加载", progress_pct=40)
                try:
                    await asyncio.get_event_loop().run_in_executor(None, run_asr_job, item)
                except Exception as e:
                    logger.error(f"[ASRWorker] Failed {item['source_id']}: {e}")
                    database.update_item_status(item["id"], "pending", str(e))
                await asyncio.sleep(1)
            else:
                await asyncio.sleep(4)
        except Exception as e:
            logger.error(f"[ASRWorker] Loop error: {e}")
            await asyncio.sleep(4)


# --- Lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    logger.info(f"Database initialized at {config.DB_PATH}")
    global download_worker_task, asr_worker_task
    download_worker_task = asyncio.create_task(download_worker())
    asr_worker_task = asyncio.create_task(asr_worker())
    logger.info(f"CyberHistoryExplorer running at http://{config.HOST}:{config.PORT}")
    yield
    if download_worker_task:
        download_worker_task.cancel()
    if asr_worker_task:
        asr_worker_task.cancel()

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

@app.get("/api/sync/range")
async def sync_range():
    """获取服务端已入库的 ts_id 范围 (min_ts_id 与 max_ts_id)"""
    return database.get_ts_range()

@app.get("/api/sync/latest_cursor")
async def latest_cursor():
    """向后兼容游标接口"""
    r = database.get_ts_range()
    if r.get("has_data") and r.get("max_item"):
        m = r["max_item"]
        return {
            "has_cursor": True,
            "cursor_id": m["source_id"],
            "item_id": m["ts_id"],
            "title": m["title"],
            "watched_at": m.get("watched_at", "")
        }
    return {"has_cursor": False, "cursor_id": None}

@app.get("/api/sync/cursors")
async def dual_cursors():
    """向后兼容双游标接口"""
    r = database.get_ts_range()
    return {
        "has_cursor": r.get("has_data", False),
        "head_cursor": r.get("min_item"),
        "tail_cursor": r.get("max_item"),
        "total_items": r.get("total", 0)
    }

@app.post("/api/sync/youtube")
async def sync_youtube(req: SyncRequest):
    items_data = [item.model_dump() for item in req.items]
    result = database.insert_items(items_data)
    logger.info(f"Sync received: inserted={result['inserted']}, ignored={result['ignored']}")
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

@app.get("/api/tasks")
async def tasks_api():
    """获取任务管理数据：总体概览统计，进行中与排队中任务列表"""
    data = database.get_tasks()
    data["pipeline_running"] = pipeline_running
    return data

@app.get("/api/pipeline/state")
async def pipeline_state():
    return {"running": pipeline_running}

@app.post("/api/pipeline/pause")
async def pipeline_pause():
    global pipeline_running
    pipeline_running = False
    logger.info("Pipeline paused by user")
    return {"running": False, "message": "已暂停任务调度"}

@app.post("/api/pipeline/resume")
async def pipeline_resume():
    global pipeline_running
    pipeline_running = True
    logger.info("Pipeline resumed by user")
    return {"running": True, "message": "已恢复任务调度"}

@app.get("/api/status")
async def status():
    stats = database.get_stats()
    return stats

# --- Entry Point ---

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=config.HOST, port=config.PORT, reload=False, log_level="info")
