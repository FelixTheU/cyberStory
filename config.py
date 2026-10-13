import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / ".data"
TEMP_DIR = DATA_DIR / "temp"

DATA_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# 数据库路径
DB_PATH = DATA_DIR / "cyber_history.db"

# 服务端口与主机
HOST = "127.0.0.1"
PORT = 8765

# 代理配置 (支持本地代理如 Clash/V2Ray，留空则不使用代理)
# 默认优先检测本机 10809 端口
PROXY_URL = os.environ.get("CYBER_PROXY", "http://127.0.0.1:10809")

# Whisper 语音识别模型配置 (无字幕视频降级使用)
# 可选: tiny, base, small, medium, large-v3-turbo
WHISPER_MODEL = os.environ.get("CYBER_WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("CYBER_WHISPER_DEVICE", "cpu")  # "cuda" 或 "cpu"
WHISPER_COMPUTE_TYPE = "int8" if WHISPER_DEVICE == "cpu" else "float16"
