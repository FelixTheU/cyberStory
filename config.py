import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / ".data"
TEMP_DIR = DATA_DIR / "temp"

DATA_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# 数据库路径
DB_PATH = DATA_DIR / "cyber_history.db"

# yt-dlp 可执行文件路径
YT_DLP_BIN = os.environ.get("CYBER_YTDLP", r"C:\Users\yview\.local\bin\yt-dlp.exe")
if not Path(YT_DLP_BIN).exists():
    YT_DLP_BIN = "yt-dlp"

# 服务端口与主机
HOST = "0.0.0.0"
PORT = 8765

# 代理配置 (支持本地代理如 Clash/V2Ray，留空则不使用代理)
# 默认优先检测本机 10809 端口
PROXY_URL = os.environ.get("CYBER_PROXY", "http://127.0.0.1:10809")

# Whisper 语音识别模型配置 (无字幕视频降级使用)
# 可选: tiny, base, small, medium, large-v3-turbo
WHISPER_MODEL = os.environ.get("CYBER_WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("CYBER_WHISPER_DEVICE", "cpu")  # "cuda" 或 "cpu"
WHISPER_COMPUTE_TYPE = "int8" if WHISPER_DEVICE == "cpu" else "float16"
# CPU 线程严格约束 (默认 2 线程，避免打满宿主机 CPU)
WHISPER_CPU_THREADS = int(os.environ.get("CYBER_WHISPER_THREADS", "2"))
# 0 表示取消长视频截断，转录完整全长音频
MAX_ASR_DURATION_SEC = 0

# 生产者-消费者音频缓冲池最大磁盘占用 (MB)，超额时触发背压限流，暂停下载音频
MAX_AUDIO_CACHE_MB = int(os.environ.get("CYBER_MAX_AUDIO_CACHE_MB", "500"))


def save_config(updates: dict):
    """更新内存中的配置变量并持久化写回 config.py 文件"""
    import re
    for k, v in updates.items():
        globals()[k] = v

    config_file = BASE_DIR / "config.py"
    if not config_file.exists():
        return
    text = config_file.read_text(encoding="utf-8")

    if "WHISPER_CPU_THREADS" in updates:
        text = re.sub(
            r'WHISPER_CPU_THREADS\s*=\s*int\(os\.environ\.get\([^,]+,\s*"[^"]*"\)\)',
            f'WHISPER_CPU_THREADS = int(os.environ.get("CYBER_WHISPER_THREADS", "{updates["WHISPER_CPU_THREADS"]}"))',
            text
        )
    if "MAX_AUDIO_CACHE_MB" in updates:
        text = re.sub(
            r'MAX_AUDIO_CACHE_MB\s*=\s*int\(os\.environ\.get\([^,]+,\s*"[^"]*"\)\)',
            f'MAX_AUDIO_CACHE_MB = int(os.environ.get("CYBER_MAX_AUDIO_CACHE_MB", "{updates["MAX_AUDIO_CACHE_MB"]}"))',
            text
        )
    if "PROXY_URL" in updates:
        text = re.sub(
            r'PROXY_URL\s*=\s*os\.environ\.get\([^,]+,\s*"[^"]*"\)',
            f'PROXY_URL = os.environ.get("CYBER_PROXY", "{updates["PROXY_URL"]}")',
            text
        )
    if "WHISPER_MODEL" in updates:
        text = re.sub(
            r'WHISPER_MODEL\s*=\s*os\.environ\.get\([^,]+,\s*"[^"]*"\)',
            f'WHISPER_MODEL = os.environ.get("CYBER_WHISPER_MODEL", "{updates["WHISPER_MODEL"]}")',
            text
        )
    config_file.write_text(text, encoding="utf-8")



