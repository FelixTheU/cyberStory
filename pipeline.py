"""
cyberstory — yt-dlp 字幕抽取与 faster-whisper ASR 管道
"""
import os
import re
import json
import time
import subprocess
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

import config
import database

logger = logging.getLogger("cyberstory.Pipeline")

def process_item(item: Dict[str, Any]):
    """处理单个视频：先尝试抓字幕，无字幕则降级 ASR，并实时更新进度与耗时"""
    source_id = item["source_id"]
    item_id = item.get("ts_id") or item["id"]
    t0 = time.time()

    # 标记为 processing
    database.update_item_status(item_id, status="processing", current_step="检测字幕", progress_pct=10)

    # 路径 A: 尝试抓取原生字幕
    segments = try_fetch_subtitles(source_id)
    if segments:
        cost = time.time() - t0
        logger.info(f"[{source_id}] Got native subtitles: {len(segments)} segments in {cost:.1f}s")
        database.save_subtitles_and_index(item_id, segments, "native", cost_time_sec=cost)
        return

    # 路径 B: ASR 降级
    logger.info(f"[{source_id}] No native subtitles, trying ASR...")
    database.update_item_status(item_id, status="processing", current_step="下载音频中", progress_pct=25)
    try:
        segments = try_asr_transcribe(source_id, item_id, t0)
        if segments:
            cost = time.time() - t0
            logger.info(f"[{source_id}] ASR transcription: {len(segments)} segments in {cost:.1f}s")
            database.save_subtitles_and_index(item_id, segments, "asr", cost_time_sec=cost)
            return
    except Exception as e:
        logger.warning(f"[{source_id}] ASR failed: {e}")

    # 均失败：仅索引标题
    cost = time.time() - t0
    logger.warning(f"[{source_id}] No subtitles available, indexing title only")
    database.save_subtitles_and_index(item_id, [], "none", cost_time_sec=cost)


def try_fetch_subtitles(video_id: str) -> Optional[List[Dict[str, Any]]]:
    """使用 yt-dlp 抓取原生/机翻字幕 (精确指定中英文言代码，避免 .* 导致 429 风控与超时)"""
    subs_dir = config.TEMP_DIR / "subs"
    subs_dir.mkdir(parents=True, exist_ok=True)

    ytdlp_bin = getattr(config, "YT_DLP_BIN", "yt-dlp")
    cmd = [
        str(ytdlp_bin),
        "--skip-download",
        "--write-sub", "--write-auto-sub",
        "--sub-lang", "zh-Hans,zh,zh-Hant,en",
        "--sub-format", "vtt",
        "-o", str(subs_dir / f"{video_id}.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    cookie_file = config.DATA_DIR / "youtube_cookies.txt"
    if cookie_file.exists():
        cmd.extend(["--cookies", str(cookie_file)])

    if config.PROXY_URL:
        cmd.insert(1, "--proxy")
        cmd.insert(2, config.PROXY_URL)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        logger.warning(f"yt-dlp subtitle fetch failed for {video_id}: {e}")
        return None

    # 查找生成的 .vtt 文件
    vtt_files = list(subs_dir.glob(f"{video_id}*.vtt"))
    if not vtt_files:
        return None

    # 优先级：zh-Hans > zh > zh-Hant > en
    chosen = vtt_files[0]
    for lang_code in ["zh-hans", "zh", "zh-hant", "en"]:
        matched = [f for f in vtt_files if lang_code in f.stem.lower()]
        if matched:
            chosen = matched[0]
            break

    segments = parse_vtt(chosen)

    # 立即清理临时字幕文件
    for f in vtt_files:
        try:
            f.unlink()
        except Exception:
            pass

    return segments if segments else None


def parse_vtt(vtt_path: Path) -> List[Dict[str, Any]]:
    """解析 WebVTT 字幕文件为 segments 列表"""
    text = vtt_path.read_text(encoding="utf-8", errors="ignore")
    segments = []
    seen_texts = set()

    # 匹配 VTT 时间行
    time_pattern = re.compile(
        r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})"
    )

    lines = text.split("\n")
    i = 0
    while i < len(lines):
        match = time_pattern.match(lines[i].strip())
        if match:
            h1, m1, s1, ms1 = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4))
            h2, m2, s2, ms2 = int(match.group(5)), int(match.group(6)), int(match.group(7)), int(match.group(8))
            start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
            end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000

            # 收集后续文本行
            i += 1
            text_lines = []
            while i < len(lines) and lines[i].strip() and not time_pattern.match(lines[i].strip()):
                line = lines[i].strip()
                # 去除 VTT 标签
                line = re.sub(r"<[^>]+>", "", line)
                if line:
                    text_lines.append(line)
                i += 1

            combined = " ".join(text_lines).strip()
            if combined and combined not in seen_texts:
                seen_texts.add(combined)
                segments.append({"start": start, "end": end, "text": combined})
        else:
            i += 1

    return segments


def download_audio_file(video_id: str, item_id: int = 0, t0: float = 0.0) -> Optional[Path]:
    """下载阶段：拉取完整音频文件，不截断。下载成功返回本地音频路径，失败返回 None"""
    audio_dir = config.TEMP_DIR / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    ytdlp_bin = getattr(config, "YT_DLP_BIN", "yt-dlp")
    audio_path = audio_dir / f"{video_id}.opus"
    
    # 若本地已有此前下载好的音频文件则复用
    actual_files = list(audio_dir.glob(f"{video_id}.*"))
    if actual_files and actual_files[0].stat().st_size > 1024:
        return actual_files[0]

    cmd = [
        str(ytdlp_bin),
        "-x", "--audio-format", "opus", "--audio-quality", "0",
        "-o", str(audio_path),
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    cookie_file = config.DATA_DIR / "youtube_cookies.txt"
    if cookie_file.exists():
        cmd.extend(["--cookies", str(cookie_file)])

    if config.PROXY_URL:
        cmd.insert(1, "--proxy")
        cmd.insert(2, config.PROXY_URL)

    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as e:
        logger.warning(f"Audio download failed for {video_id}: {e}")
        return None

    actual_files = list(audio_dir.glob(f"{video_id}.*"))
    return actual_files[0] if actual_files else None


def transcribe_audio_file(audio_path: Path, video_id: str, item_id: int = 0, t0: float = 0.0) -> Optional[List[Dict[str, Any]]]:
    """ASR 阶段：使用 faster-whisper 转录本地音频，并在完成后强制删除音频文件"""
    # 限制进程优先级为低于正常
    try:
        import psutil
        p = psutil.Process()
        if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):
            p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    except Exception:
        pass

    try:
        if item_id:
            elapsed = time.time() - t0 if t0 else 0
            database.update_item_status(item_id, status="processing", current_step="Whisper模型加载", progress_pct=40, cost_time_sec=elapsed)

        from faster_whisper import WhisperModel
        model = WhisperModel(
            config.WHISPER_MODEL,
            device=config.WHISPER_DEVICE,
            compute_type=config.WHISPER_COMPUTE_TYPE,
            cpu_threads=getattr(config, "WHISPER_CPU_THREADS", 2),
            num_workers=1
        )

        if item_id:
            elapsed = time.time() - t0 if t0 else 0
            database.update_item_status(item_id, status="processing", current_step="Whisper语音推理中", progress_pct=50, cost_time_sec=elapsed)

        segments_gen, info = model.transcribe(
            str(audio_path),
            beam_size=5,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        segments = []
        total_duration = info.duration if hasattr(info, 'duration') and info.duration else 0
        last_progress_update = time.time()

        for seg in segments_gen:
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip()
            })
            now = time.time()
            if item_id and total_duration > 0 and (now - last_progress_update > 3.0):
                last_progress_update = now
                calc_pct = int(50 + (min(seg.end, total_duration) / total_duration) * 45)
                calc_pct = min(98, max(50, calc_pct))
                elapsed = now - t0 if t0 else 0
                database.update_item_status(item_id, status="processing", current_step="Whisper语音推理中", progress_pct=calc_pct, cost_time_sec=elapsed)

        return segments if segments else None

    except ImportError:
        logger.warning("faster-whisper not installed, skipping ASR")
        return None
    finally:
        # ASR 完成或异常后，立即彻底清理本地音频文件
        try:
            if audio_path and audio_path.exists():
                audio_path.unlink(missing_ok=True)
                logger.info(f"Cleaned up audio file: {audio_path.name}")
        except Exception as e:
            logger.warning(f"Failed to delete audio file {audio_path}: {e}")


def try_asr_transcribe(video_id: str, item_id: int = 0, t0: float = 0.0) -> Optional[List[Dict[str, Any]]]:
    """单 worker 模式兼容入口：串联下载与 ASR"""
    audio_path = download_audio_file(video_id, item_id=item_id, t0=t0)
    if not audio_path:
        return None
    return transcribe_audio_file(audio_path, video_id, item_id=item_id, t0=t0)
