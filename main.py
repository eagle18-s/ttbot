import os
import time
import tempfile
import threading
import logging
import asyncio
from datetime import datetime

from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction
from telegram.request import HTTPXRequest
import yt_dlp
import requests
from dotenv import load_dotenv

load_dotenv()

# ================== KONFİQURASİYA ==================
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID")  # rəqəm (məs: 123456789)
KEEP_ALIVE_URL = "https://ttbot-vw3o.onrender.com/"
PING_INTERVAL = 240  # 4 dəqiqə (Render üçün daha stabil)

if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN environment variable yoxdur!")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ================== FLASK ==================
app = Flask(__name__)

@app.route("/")
def health():
    return "Bot aktivdir ✅", 200

@app.route("/ping")
def ping():
    return "pong", 200

# ================== KEEP-ALIVE ==================
def keep_alive_loop(bot):
    """Sadə və təhlükəsiz keep-alive (event loop pozmur)"""
    while True:
        try:
            resp = requests.get(KEEP_ALIVE_URL, timeout=12)
            logger.info(f"Keep-alive ping → {resp.status_code}")

            if ADMIN_CHAT_ID:
                try:
                    # Sync üsulla göndəririk (thread-safe)
                    bot.send_message(
                        chat_id=int(ADMIN_CHAT_ID),
                        text=f"✅ Ping göndərilib, bot aktivdir\n🕒 {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}\nStatus: {resp.status_code}"
                    )
                except Exception as e:
                    logger.warning(f"Admin mesajı göndərilmədi: {e}")

        except Exception as e:
            logger.error(f"Keep-alive xətası: {e}")

        time.sleep(PING_INTERVAL)

# ================== VIDEO YÜKLƏMƏ ==================
def download_video(url: str) -> str | None:
    """yt-dlp ilə video yükləyir. Şəkil/slayd olduqda None qaytarır."""
    ydl_opts = {
        "format": "best[height<=720][ext=mp4]/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best",
        "outtmpl": os.path.join(tempfile.gettempdir(), "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 4,
        "fragment_retries": 4,
        "socket_timeout": 30,
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Referer": "https://www.tiktok.com/",
        },
        # TikTok + Instagram üçün
        "extractor_args": {
            "tiktok": {"webpage_download": True},
        },
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

            # Video olub-olmadığını yoxla
            if info.get("_type") == "playlist" or not info.get("ext") in ["mp4", "webm", "mkv"]:
                # Bəzən şəkil postu gəlir
                if not info.get("duration"):
                    logger.warning(f"Video deyil (şəkil/slayd): {url}")
                    return None

            filename = ydl.prepare_filename(info)

            if not os.path.exists(filename):
                # Bəzən extension dəyişir
                for f in os.listdir(tempfile.gettempdir()):
                    if str(info.get("id")) in f and f.endswith((".mp4", ".webm", ".mkv")):
                        filename = os.path.join(tempfile.gettempdir(), f)
                        break

            if os.path.exists(filename) and os.path.getsize(filename) > 10000:  # 10KB-dan böyük olsun
                return filename
            return None

    except Exception as e:
        logger.error(f"Download xətası [{url}]: {e}")
        return None

# ================== ERROR HANDLER ==================
async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE):
    logger.error("Exception while handling an update:", exc_info=context.error)

# ================== HANDLERS ==================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🎬 Salam!\n\n"
        "Mənə **TikTok**, **Instagram**, **YouTube** və digər platformalardan link at.\n"
        "Mən sənə **su nişansız** video göndərəcəyəm.\n\n"
        "Sadəcə linki göndər 👇"
    )

async def handle_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = update.message.text.strip()

    if not url.startswith(("http://", "https://")):
        await update.message.reply_text("Zəhmət olmasa düzgün link göndər.")
        return

    status_msg = await update.message.reply_text("⏳ Video yüklənir, bir az gözləyin...")
    await update.message.chat.send_action(ChatAction.UPLOAD_VIDEO)

    file_path = None
    try:
        loop = asyncio.get_running_loop()
        file_path = await loop.run_in_executor(None, download_video, url)

        if not file_path or not os.path.exists(file_path):
            await status_msg.edit_text(
                "❌ Video yüklənə bilmədi.\n\n"
                "• Linkdə video olmaya bilər (şəkil / slayd postu)\n"
                "• Link etibarsız və ya silinib ola bilər\n"
                "• Bəzi Instagram Reels-lər üçün cookies lazımdır"
            )
            return

        size_mb = os.path.getsize(file_path) / (1024 * 1024)

        if size_mb > 49.5:
            await status_msg.edit_text(
                f"⚠️ Video çox böyükdür ({size_mb:.1f} MB).\n"
                "Telegram limiti 50 MB-dır. Daha qısa video göndərin."
            )
            return

        with open(file_path, "rb") as video_file:
            await update.message.reply_video(
                video=video_file,
                caption="✅ Su nişansız video hazırdır!",
                supports_streaming=True,
                read_timeout=60,
                write_timeout=60,
                connect_timeout=30
            )

        await status_msg.delete()

    except Exception as e:
        logger.error(f"Handler xətası: {e}", exc_info=True)
        try:
            await status_msg.edit_text("❌ Xəta baş verdi. Bir az sonra yenidən cəhd edin.")
        except:
            pass
    finally:
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except:
                pass

# ================== START ==================
def main():
    # Event loop hazırla
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    # Daha böyük connection pool (Render + Telegram üçün)
    request = HTTPXRequest(
        connection_pool_size=30,
        pool_timeout=20.0,
        connect_timeout=20.0,
        read_timeout=40.0,
        write_timeout=40.0
    )

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .request(request)
        .build()
    )

    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_link))
    application.add_error_handler(error_handler)

    # Keep-alive thread (bot obyektini veririk)
    ka_thread = threading.Thread(
        target=keep_alive_loop,
        args=(application.bot,),
        daemon=True
    )
    ka_thread.start()
    logger.info("Keep-alive thread started")

    # Flask health server
    port = int(os.environ.get("PORT", 10000))
    flask_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False),
        daemon=True
    )
    flask_thread.start()
    logger.info(f"Flask started on port {port}")

    logger.info("Bot polling başladı...")
    application.run_polling(
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=True,
        close_loop=False
    )

if __name__ == "__main__":
    main()
