import os
import time
import threading
import logging
import tempfile
import asyncio
from datetime import datetime

from flask import Flask
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from telegram.constants import ChatAction
import yt_dlp
import requests
from dotenv import load_dotenv

load_dotenv()

# ================== KONFİQURASİYA ==================
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID")
KEEP_ALIVE_URL = "https://ttbot-vw3o.onrender.com/"
PING_INTERVAL = 300  # 2 dəqiqə

if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN environment variable yoxdur!")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ================== FLASK (Render health check) ==================
app = Flask(__name__)

@app.route("/")
def health():
    return "Bot aktivdir ✅", 200

@app.route("/ping")
def ping():
    return "pong", 200

# ================== KEEP-ALIVE + ADMIN MESAJ ==================
def keep_alive_loop(application: Application):
    """Hər 2 dəqiqədən bir ping atır və adminə mesaj göndərir"""
    while True:
        try:
            resp = requests.get(KEEP_ALIVE_URL, timeout=15)
            status = resp.status_code
            logger.info(f"Keep-alive ping: {status}")

            if ADMIN_CHAT_ID:
                msg = f"✅ Ping göndərilib, bot aktivdir\n🕒 {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}\nStatus: {status}"
                try:
                    asyncio.run(
                        application.bot.send_message(
                            chat_id=int(ADMIN_CHAT_ID),
                            text=msg
                        )
                    )
                except Exception as e:
                    logger.error(f"Admin mesajı göndərilmədi: {e}")

        except Exception as e:
            logger.error(f"Keep-alive xətası: {e}")

        time.sleep(PING_INTERVAL)

# ================== VIDEO YÜKLƏMƏ (TikTok & YouTube üçün optimallaşdırılmış) ==================
def download_video(url: str) -> str | None:
    """yt-dlp ilə video yükləyir, temp path qaytarır"""
    ydl_opts = {
        # FFmpeg tələb etməyən və birbaşa birləşdirilmiş mp4 formatlarını üstün tutur
        "format": "best[height<=720][ext=mp4]/best[ext=mp4]/best",
        "outtmpl": os.path.join(tempfile.gettempdir(), "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        # TikTok və digər platformalar üçün əlavə başlıqlar (bloklanmanın qarşısını almaq üçün)
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info)
            if not os.path.exists(filename):
                for f in os.listdir(tempfile.gettempdir()):
                    if info.get("id") in f:
                        filename = os.path.join(tempfile.gettempdir(), f)
                        break
            return filename if os.path.exists(filename) else None
    except Exception as e:
        logger.error(f"Download xətası ({url}): {e}")
        return None

# ================== TELEGRAM HANDLERS ==================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🎬 Salam! Mənə TikTok, Instagram, YouTube və digər linkləri at.\n"
        "Mən sənə su nişansız video göndərəcəyəm.\n\n"
        "Sadəcə linki göndər 👇"
    )

async def handle_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    url = update.message.text.strip()

    if not url.startswith(("http://", "https://")):
        await update.message.reply_text("Zəhmət olmasa düzgün link göndər.")
        return

    await update.message.chat.send_action(ChatAction.UPLOAD_VIDEO)
    status_msg = await update.message.reply_text("⏳ Video yüklənir, gözləyin...")

    file_path = None
    try:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()

        file_path = await loop.run_in_executor(None, download_video, url)

        if not file_path or not os.path.exists(file_path):
            await status_msg.edit_text("❌ Video yüklənə bilmədi. Linki yoxlayın və ya yenidən cəhd edin.")
            return

        file_size = os.path.getsize(file_path) / (1024 * 1024)  # MB

        if file_size > 49:
            await status_msg.edit_text(
                f"⚠️ Video çox böyükdür ({file_size:.1f} MB). Telegram limit 50 MB-dır.\n"
                "Zəhmət olmasa qısa video göndərin."
            )
            return

        with open(file_path, "rb") as f:
            await update.message.reply_video(
                video=f,
                caption="✅ Su nişansız video hazırdır!",
                supports_streaming=True
            )

        await status_msg.delete()

    except Exception as e:
        logger.error(f"Handler xətası: {e}")
        await status_msg.edit_text("❌ Xəta baş verdi. Yenidən cəhd edin.")
    finally:
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except:
                pass

# ================== START ==================
def run_bot():
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())

    application = Application.builder().token(BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_link))

    keep_alive_thread = threading.Thread(
        target=keep_alive_loop,
        args=(application,),
        daemon=True
    )
    keep_alive_thread.start()
    logger.info("Keep-alive thread started (every 2 min)")

    logger.info("Bot started...")
    application.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=True)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))

    flask_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False),
        daemon=True
    )
    flask_thread.start()
    logger.info(f"Flask health server started on port {port}")

    run_bot()
                               
