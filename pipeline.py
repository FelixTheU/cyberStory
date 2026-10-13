"""
CyberHistoryExplorer — yt-dlp 字幕抽取与 faster-whisper ASR 管道
"""
import os
import re
import json
import subprocess
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

import config
import database

logger = logging.getLogger("CyberHistory.Pipeline")

def process_item(item: Dict[str, Any]):
    """处理单个视频：先尝试抓字幕，无字幕则降级 ASR"""
    source_id = item["source_id"]
    item_id = item["id"]

    # 路径 A: 尝试抓取原生字幕
    segments = try_fetch_subtitles(source_id)
    if segments:
        logger.info(f"[{source_id}] Got native subtitles: {len(segments)} segments")
        database.save_subtitles_and_index(item_id, segments, "native")
        return

    # 路径 B: ASR 降级
    logger.info(f"[{source_id}] No native subtitles, trying ASR...")
    try:
        segments = try_asr_transcribe(source_id)
        if segments:
            logger.info(f"[{source_id}] ASR transcription: {len(segments)} segments")
            database.save_subtitles_and_index(item_id, segments, "asr")
            return
    except Exception as e:
        logger.warning(f"[{source_id}] ASR failed: {e}")

    # 均失败：仅索引标题
    logger.warning(f"[{source_id}] No subtitles available, indexing title only")
    database.save_subtitles_and_index(item_id, [], "none")


def try_fetch_subtitles(video_id: str) -> Optional[List[Dict[str, Any]]]:
    """使用 yt-dlp 抓取原生字幕"""
    subs_dir = config.TEMP_DIR / "subs"
    subs_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "yt-dlp",
        "--skip-download",
        "--write-sub", "--write-auto-sub",
        "--sub-lang", "zh-Hans,zh,zh-Hant,en",
        "--sub-format", "vtt",
        "-o", str(subs_dir / f"{video_id}.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    if config.PROXY_URL:
        cmd.insert(1, "--proxy")
        cmd.insert(2, config.PROXY_URL)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        logger.warning(f"yt-dlp failed for {video_id}: {e}")
        return None

    # 查找生成的 .vtt 文件
    vtt_files = list(subs_dir.glob(f"{video_id}*.vtt"))
    if not vtt_files:
        return None

    # 优先中文
    chosen = vtt_files[0]
    for f in vtt_files:
        if "zh" in f.stem.lower():
            chosen = f
            break

    segments = parse_vtt(chosen)

    # 清理临时文件
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


def try_asr_transcribe(video_id: str) -> Optional[List[Dict[str, Any]]]:
    """使用 faster-whisper 进行本地 ASR 转写"""
    audio_dir = config.TEMP_DIR / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    # 下载音频
    audio_path = audio_dir / f"{video_id}.opus"
    cmd = [
        "yt-dlp",
        "-x", "--audio-format", "opus", "--audio-quality", "0",
        "-o", str(audio_path),
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    if config.PROXY_URL:
        cmd.insert(1, "--proxy")
        cmd.insert(2, config.PROXY_URL)

    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except Exception as e:
        logger.warning(f"Audio download failed for {video_id}: {e}")
        return None

    # 查找实际输出文件
    actual_files = list(audio_dir.glob(f"{video_id}.*"))
    if not actual_files:
        return None

    actual_path = actual_files[0]

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(config.WHISPER_MODEL, device=config.WHISPER_DEVICE, compute_type=config.WHISPER_COMPUTE_TYPE)
        segments_gen, info = model.transcribe(
            str(actual_path),
            beam_size=5,
            language="zh",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        segments = []
        for seg in segments_gen:
            segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip()
            })
        return segments if segments else None

    except ImportError:
        logger.warning("faster-whisper not installed, skipping ASR")
        return None
    finally:
        # 清理音频文件
        try:
            actual_path.unlink(missing_ok=True)
        except Exception:
            pass
