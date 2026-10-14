import sqlite3
import re
from typing import List, Dict, Any, Optional
from config import DB_PATH

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. 核心条目表 (Append-Only 流水日志，严格只添加不插值)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'youtube',
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        url TEXT NOT NULL,
        duration_sec INTEGER DEFAULT 0,
        thumbnail_url TEXT,
        watched_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, ready, failed
        sub_source TEXT,                        -- native, asr, none
        progress_pct INTEGER DEFAULT 0,         -- 进度百分比 0-100
        cost_time_sec REAL DEFAULT 0,           -- 总耗费秒数
        current_step TEXT,                      -- 当前步骤，如 '下载音频', 'Whisper识别'
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 尝试补充新增列 (兼容已创建的数据库)
    for col_def in [
        ("progress_pct", "INTEGER DEFAULT 0"),
        ("cost_time_sec", "REAL DEFAULT 0"),
        ("current_step", "TEXT")
    ]:
        try:
            cursor.execute(f"ALTER TABLE items ADD COLUMN {col_def[0]} {col_def[1]};")
        except Exception:
            pass

    
    # 2. 字幕分段表
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS video_subtitles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_video_subtitles_item ON video_subtitles(item_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_video_subtitles_time ON video_subtitles(item_id, start_sec);")
    
    # 3. FTS5 全文索引虚拟表 (使用 trigram 分词)
    cursor.execute("""
    CREATE VIRTUAL TABLE IF NOT EXISTS subtitles_fts USING fts5(
        item_id UNINDEXED,
        title,
        author,
        content,
        tokenize = 'trigram'
    );
    """)

    # 服务重启时，将异常中断的 processing 状态重置回 pending
    cursor.execute("""
    UPDATE items
    SET status = 'pending', current_step = NULL, progress_pct = 0
    WHERE status = 'processing';
    """)
    
    conn.commit()
    conn.close()

def get_dual_cursors() -> Dict[str, Any]:
    """获取当前历史记录表的最老游标 (head_cursor，用于向过去回溯) 与最新游标 (tail_cursor，用于常规向未来追加)"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT min(id), max(id), count(*) FROM items;")
    min_id, max_id, count = cursor.fetchone()
    
    if not count:
        conn.close()
        return {"has_cursor": False, "head_cursor": None, "tail_cursor": None, "total_items": 0}
        
    cursor.execute("SELECT id, source_id, title, watched_at, created_at FROM items WHERE id = ?;", (min_id,))
    head_row = dict(cursor.fetchone())
    
    cursor.execute("SELECT id, source_id, title, watched_at, created_at FROM items WHERE id = ?;", (max_id,))
    tail_row = dict(cursor.fetchone())
    
    conn.close()
    return {
        "has_cursor": True,
        "head_cursor": head_row, # 最老的一条 (向过去回溯半年前/一年前时的分界线)
        "tail_cursor": tail_row, # 最新的一条 (常规同步明天/后天时的分界线)
        "total_items": count
    }

def get_latest_cursor() -> Optional[Dict[str, Any]]:
    """向后兼容：获取历史记录表中最后一条记录 (即 tail_cursor 最新观看记录) 作为常规追加分界线"""
    cursors = get_dual_cursors()
    return cursors.get("tail_cursor")

def insert_items(items_data: List[Dict[str, Any]], direction: str = "tail_append") -> Dict[str, int]:
    """
    双向增量日志写入 (Append-Only / Prepend-Only):
    - direction == "tail_append": 常规同步，向未来产生的新视频在表尾追加 (分配 id > max_id)
    - direction == "head_prepend": 深度同步，向过去回溯半年/一年前的历史视频在表头插入 (分配 id < min_id)
    初始基准 ID 从 1,000,000 起始，向过去预留 100 万个历史坑位，向未来无限递增。
    如果视频此前已转写过字幕，自动复用已有字幕，不重复耗费 CPU。
    """
    if not items_data:
        return {"inserted": 0, "updated": 0}
        
    conn = get_connection()
    cursor = conn.cursor()
    inserted = 0
    
    cursor.execute("SELECT min(id), max(id), count(*) FROM items;")
    curr_min_id, curr_max_id, count = cursor.fetchone()
    
    if not count:
        curr_min_id = 1000000
        curr_max_id = 1000000
        
    if direction == "head_prepend":
        # 头部回溯插入：items_data 在页面上自上而下 (较近过去 -> 更深过去)
        # 按时间发生顺序，更深过去的应先获得较小的 id，较近过去的获得贴近 min_id 的 id
        # 例如 K 条数据：最老分配 (min_id - K)，次老分配 (min_id - K + 1)...
        total_k = len(items_data)
        ordered_items = list(reversed(items_data)) # 反转为从更深过去到较近过去
        next_id_start = (curr_min_id - total_k)
    else:
        # 尾部常规追加：items_data 传入时已反转为正序 (较旧在前、最新在后)
        ordered_items = items_data
        next_id_start = curr_max_id + 1

    for idx, item in enumerate(ordered_items):
        source = item.get("source", "youtube")
        source_id = item.get("videoId") or item.get("source_id")
        if not source_id:
            continue
        title = item.get("title", "")
        author = item.get("channel") or item.get("author", "")
        url = item.get("url") or f"https://www.youtube.com/watch?v={source_id}"
        duration_sec = int(item.get("duration_sec", 0))
        thumbnail_url = item.get("thumbnail") or item.get("thumbnail_url") or f"https://i.ytimg.com/vi/{source_id}/hqdefault.jpg"
        watched_at = item.get("watchedDate") or item.get("watched_at", "")
        
        assigned_id = next_id_start + idx
        
        # 检查之前是否已经处理就绪过同源视频 (复用字幕)
        cursor.execute("""
        SELECT id, sub_source, cost_time_sec 
        FROM items 
        WHERE source = ? AND source_id = ? AND status = 'ready'
        ORDER BY id DESC LIMIT 1;
        """, (source, source_id))
        prev_ready = cursor.fetchone()
        
        initial_status = 'ready' if prev_ready else 'pending'
        sub_source = prev_ready["sub_source"] if prev_ready else None
        cost_time = prev_ready["cost_time_sec"] if prev_ready else 0.0
        step_text = '已完成 (复用)' if prev_ready else None
        progress = 100 if prev_ready else 0

        cursor.execute("""
        INSERT INTO items (id, source, source_id, title, author, url, duration_sec, thumbnail_url, watched_at, status, sub_source, progress_pct, cost_time_sec, current_step)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        """, (assigned_id, source, source_id, title, author, url, duration_sec, thumbnail_url, watched_at, initial_status, sub_source, progress, cost_time, step_text))
        
        inserted += 1
        
        # 若之前有已完成的字幕，直接把字幕分段关联/复制一份到新 assigned_id
        if prev_ready:
            old_item_id = prev_ready["id"]
            cursor.execute("""
            INSERT INTO video_subtitles (item_id, start_sec, end_sec, text)
            SELECT ?, start_sec, end_sec, text
            FROM video_subtitles WHERE item_id = ?;
            """, (assigned_id, old_item_id))
            
            cursor.execute("""
            INSERT INTO subtitles_fts (item_id, title, author, content)
            SELECT ?, title, author, content
            FROM subtitles_fts WHERE item_id = ?;
            """, (assigned_id, old_item_id))

    # 更新 sqlite 自增游标
    cursor.execute("SELECT max(id) FROM items;")
    new_max = cursor.fetchone()[0]
    cursor.execute("DELETE FROM sqlite_sequence WHERE name='items';")
    cursor.execute("INSERT INTO sqlite_sequence (name, seq) VALUES ('items', ?);", (new_max,))

    conn.commit()
    conn.close()
    return {"inserted": inserted, "updated": 0}

def get_next_pending_item() -> Optional[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    # 采用短作业优先 (SJF) 调度策略：短视频优先处理，避免超长视频阻塞队列
    cursor.execute("""
    SELECT id, source, source_id, title, author, url, duration_sec
    FROM items
    WHERE status = 'pending'
    ORDER BY 
        CASE WHEN duration_sec <= 0 THEN 999999 ELSE duration_sec END ASC,
        id ASC
    LIMIT 1;
    """)
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def update_item_status(item_id: int, status: str, error_message: Optional[str] = None, sub_source: Optional[str] = None, progress_pct: Optional[int] = None, cost_time_sec: Optional[float] = None, current_step: Optional[str] = None):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE items
    SET status = ?, 
        error_message = ?, 
        sub_source = COALESCE(?, sub_source),
        progress_pct = COALESCE(?, progress_pct),
        cost_time_sec = COALESCE(?, cost_time_sec),
        current_step = COALESCE(?, current_step),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?;
    """, (status, error_message, sub_source, progress_pct, cost_time_sec, current_step, item_id))
    conn.commit()
    conn.close()

def save_subtitles_and_index(item_id: int, segments: List[Dict[str, Any]], sub_source: str, cost_time_sec: float = 0.0):
    """保存分段字幕，并生成全文索引"""
    conn = get_connection()
    cursor = conn.cursor()
    
    # 清理旧数据
    cursor.execute("DELETE FROM video_subtitles WHERE item_id = ?;", (item_id,))
    cursor.execute("DELETE FROM subtitles_fts WHERE item_id = ?;", (item_id,))
    
    # 插入分段
    full_text_parts = []
    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        start_sec = float(seg.get("start", 0.0))
        end_sec = float(seg.get("end", 0.0))
        cursor.execute("""
        INSERT INTO video_subtitles (item_id, start_sec, end_sec, text)
        VALUES (?, ?, ?, ?);
        """, (item_id, start_sec, end_sec, text))
        full_text_parts.append(text)
        
    full_content = " ".join(full_text_parts)
    
    # 获取标题和作者
    cursor.execute("SELECT title, author FROM items WHERE id = ?;", (item_id,))
    row = cursor.fetchone()
    title = row["title"] if row else ""
    author = row["author"] if row else ""
    
    # 插入 FTS5 虚拟表
    if full_content or title:
        cursor.execute("""
        INSERT INTO subtitles_fts (item_id, title, author, content)
        VALUES (?, ?, ?, ?);
        """, (item_id, title, author, full_content))
        
    # 更新 items 状态
    cursor.execute("""
    UPDATE items
    SET status = 'ready', 
        sub_source = ?, 
        progress_pct = 100, 
        cost_time_sec = ?, 
        current_step = '已完成',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?;
    """, (sub_source, cost_time_sec, item_id))
    
    conn.commit()
    conn.close()

def _format_time(sec: float) -> str:
    total_sec = int(sec)
    m, s = divmod(total_sec, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"

def search(query: str, page: int = 1, page_size: int = 20, source: Optional[str] = None) -> Dict[str, Any]:
    """统一全文搜索支持中英文（短语及 FTS5 trigram 复合检索），支持 source 筛选"""
    query = query.strip()
    if not query:
        return {"items": [], "total": 0, "page": page, "page_size": page_size}
        
    conn = get_connection()
    cursor = conn.cursor()
    offset = (page - 1) * page_size
    
    results = []
    source_filter = source.strip().lower() if source and source.strip().lower() != 'all' else None
    
    # 若检索词 >= 3 字符，优先使用 FTS5 检索
    if len(query) >= 3:
        try:
            # 清理 query 中非法字符
            safe_query = re.sub(r'["\'\*\^\:\(\)]', ' ', query).strip()
            # FTS5 trigram 匹配：每个词带双引号精确切片匹配
            fts_match_expr = f'"{safe_query}"'
            
            if source_filter:
                cursor.execute("""
                SELECT 
                    i.id, i.source, i.source_id, i.title, i.author, i.url, i.duration_sec,
                    i.thumbnail_url, i.watched_at, i.sub_source,
                    snippet(subtitles_fts, 3, '<mark>', '</mark>', '...', 18) as fts_snippet,
                    bm25(subtitles_fts) as rank
                FROM subtitles_fts f
                JOIN items i ON i.id = f.item_id
                WHERE subtitles_fts MATCH ? AND i.source = ?
                ORDER BY rank ASC
                LIMIT ? OFFSET ?;
                """, (fts_match_expr, source_filter, page_size, offset))
            else:
                cursor.execute("""
                SELECT 
                    i.id, i.source, i.source_id, i.title, i.author, i.url, i.duration_sec,
                    i.thumbnail_url, i.watched_at, i.sub_source,
                    snippet(subtitles_fts, 3, '<mark>', '</mark>', '...', 18) as fts_snippet,
                    bm25(subtitles_fts) as rank
                FROM subtitles_fts f
                JOIN items i ON i.id = f.item_id
                WHERE subtitles_fts MATCH ?
                ORDER BY rank ASC
                LIMIT ? OFFSET ?;
                """, (fts_match_expr, page_size, offset))
            
            rows = cursor.fetchall()
            for r in rows:
                item_dict = dict(r)
                # 寻找具体的命中秒数
                item_id = item_dict["id"]
                cursor.execute("""
                SELECT start_sec, text
                FROM video_subtitles
                WHERE item_id = ? AND text LIKE ?
                ORDER BY start_sec ASC
                LIMIT 1;
                """, (item_id, f"%{query}%"))
                match_seg = cursor.fetchone()
                
                start_sec = match_seg["start_sec"] if match_seg else 0.0
                time_str = _format_time(start_sec)
                
                snippet_text = item_dict.get("fts_snippet")
                if not snippet_text or "<mark>" not in snippet_text:
                    if match_seg:
                        raw = match_seg["text"]
                        snippet_text = re.sub(re.escape(query), f"<mark>{query}</mark>", raw, flags=re.IGNORECASE)
                    else:
                        snippet_text = item_dict["title"]
                        
                item_dict["time_stamp"] = time_str
                item_dict["start_sec"] = start_sec
                item_dict["jump_url"] = f"{item_dict['url']}&t={int(start_sec)}s"
                item_dict["snippet"] = snippet_text
                results.append(item_dict)
                
        except Exception:
            results = []

    # 若 FTS5 无结果或 query < 3 字符，使用模糊匹配
    if not results:
        like_expr = f"%{query}%"
        if source_filter:
            cursor.execute("""
            SELECT DISTINCT i.id, i.source, i.source_id, i.title, i.author, i.url, i.duration_sec,
                   i.thumbnail_url, i.watched_at, i.sub_source
            FROM items i
            LEFT JOIN video_subtitles vs ON vs.item_id = i.id
            WHERE (i.title LIKE ? OR i.author LIKE ? OR vs.text LIKE ?) AND i.source = ?
            ORDER BY i.id DESC
            LIMIT ? OFFSET ?;
            """, (like_expr, like_expr, like_expr, source_filter, page_size, offset))
        else:
            cursor.execute("""
            SELECT DISTINCT i.id, i.source, i.source_id, i.title, i.author, i.url, i.duration_sec,
                   i.thumbnail_url, i.watched_at, i.sub_source
            FROM items i
            LEFT JOIN video_subtitles vs ON vs.item_id = i.id
            WHERE i.title LIKE ? OR i.author LIKE ? OR vs.text LIKE ?
            ORDER BY i.id DESC
            LIMIT ? OFFSET ?;
            """, (like_expr, like_expr, like_expr, page_size, offset))
        
        rows = cursor.fetchall()
        for r in rows:
            item_dict = dict(r)
            item_id = item_dict["id"]
            
            # 找到命中的台词片段
            cursor.execute("""
            SELECT start_sec, text
            FROM video_subtitles
            WHERE item_id = ? AND text LIKE ?
            ORDER BY start_sec ASC
            LIMIT 1;
            """, (item_id, like_expr))
            match_seg = cursor.fetchone()
            
            if match_seg:
                start_sec = match_seg["start_sec"]
                time_str = _format_time(start_sec)
                raw_text = match_seg["text"]
                snippet = re.sub(re.escape(query), f"<mark>{query}</mark>", raw_text, flags=re.IGNORECASE)
            else:
                start_sec = 0.0
                time_str = "00:00"
                snippet = re.sub(re.escape(query), f"<mark>{query}</mark>", item_dict["title"], flags=re.IGNORECASE)
                
            item_dict["time_stamp"] = time_str
            item_dict["start_sec"] = start_sec
            item_dict["jump_url"] = f"{item_dict['url']}&t={int(start_sec)}s" if start_sec > 0 else item_dict["url"]
            item_dict["snippet"] = snippet
            results.append(item_dict)
            
    conn.close()
    return {
        "items": results,
        "total": len(results),
        "page": page,
        "page_size": page_size
    }

def get_item_subtitles(item_id: int) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT start_sec, end_sec, text
    FROM video_subtitles
    WHERE item_id = ?
    ORDER BY start_sec ASC;
    """, (item_id,))
    rows = cursor.fetchall()
    
    segments = []
    for r in rows:
        segments.append({
            "start": r["start_sec"],
            "end": r["end_sec"],
            "time_str": _format_time(r["start_sec"]),
            "text": r["text"]
        })
    conn.close()
    return segments

def parse_date_score(label: str) -> float:
    """将人类可读日期 (如 '今天', '昨天', '10月6日', '星期一') 解析为时间戳权重，保证最新日期排在最前"""
    if not label:
        return 0.0
    l = label.strip()
    from datetime import datetime, timedelta
    now = datetime.now()
    
    if '今天' in l or 'Today' in l:
        return now.timestamp()
    if '昨天' in l or 'Yesterday' in l:
        return (now - timedelta(days=1)).timestamp()
    
    # 匹配 "10月13日"、"9月11日"、"2026年10月13日"
    m = re.search(r'(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日', l)
    if m:
        year = int(m.group(1)) if m.group(1) else now.year
        month = int(m.group(2))
        day = int(m.group(3))
        try:
            return datetime(year, month, day).timestamp()
        except Exception:
            return 0.0
            
    # 匹配 "星期X" (本周内的相对星期)
    weekdays = {'星期一': 0, '星期二': 1, '星期三': 2, '星期四': 3, '星期五': 4, '星期六': 5, '星期日': 6, '星期天': 6}
    for w_name, w_idx in weekdays.items():
        if w_name in l:
            diff = (now.weekday() - w_idx) % 7
            if diff == 0:
                diff = 7
            target_date = now - timedelta(days=diff)
            return target_date.timestamp()
            
    return 0.0

def get_history_feed() -> List[Dict[str, Any]]:
    """历史记录页面倒序展示历史记录表中的记录 (严格按照纯追加日志 ORDER BY id DESC)"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, source_id, title, author, url, duration_sec, thumbnail_url,
           watched_at, status, sub_source, progress_pct, cost_time_sec, current_step, error_message, updated_at,
           (strftime('%s', 'now') - strftime('%s', updated_at)) as live_elapsed_sec
    FROM items
    ORDER BY id DESC;
    """)
    rows = cursor.fetchall()
    
    # 按倒序遍历到的先后顺序自然组织日期分组与组内条目 (最新观看永远在最顶部)
    groups_map = {}
    ordered_groups = []
    
    for r in rows:
        d = dict(r)
        d["duration_str"] = _format_time(d["duration_sec"]) if d["duration_sec"] else "00:00"
        
        # 格式化耗时
        cost_sec = d.get("cost_time_sec") or 0.0
        if d.get("status") == "processing" and cost_sec <= 0:
            cost_sec = float(d.get("live_elapsed_sec") or 0.0)

        if cost_sec >= 60:
            m = int(cost_sec // 60)
            s = int(cost_sec % 60)
            d["cost_time_str"] = f"{m}m{s}s"
        else:
            d["cost_time_str"] = f"{int(cost_sec)}s"
            
        group_title = d.get("watched_at") or "更早"
        if group_title not in groups_map:
            group_obj = {
                "date": group_title,
                "items": []
            }
            groups_map[group_title] = group_obj
            ordered_groups.append(group_obj)
            
        groups_map[group_title]["items"].append(d)
        
    conn.close()
    return ordered_groups

def get_stats() -> Dict[str, Any]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT count(*) FROM items;")
    total = cursor.fetchone()[0]
    
    cursor.execute("SELECT count(*) FROM items WHERE status = 'ready';")
    ready = cursor.fetchone()[0]
    
    cursor.execute("SELECT count(*) FROM items WHERE status = 'pending';")
    pending = cursor.fetchone()[0]
    
    cursor.execute("SELECT count(*) FROM items WHERE status = 'processing';")
    processing = cursor.fetchone()[0]
    
    cursor.execute("SELECT count(*) FROM items WHERE status = 'failed';")
    failed = cursor.fetchone()[0]
    
    cursor.execute("SELECT count(*) FROM video_subtitles;")
    total_segments = cursor.fetchone()[0]
    
    conn.close()
    return {
        "total_videos": total,
        "ready": ready,
        "pending": pending,
        "processing": processing,
        "failed": failed,
        "total_segments": total_segments
    }
