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
# 单视频最大 ASR 识别时长限制 (秒，默认 45 分钟，防止超长视频无限占用)
MAX_ASR_DURATION_SEC = int(os.environ.get("CYBER_MAX_ASR_SEC", "2700"))

