import sys
import torch
from PIL import Image
from ultralytics import YOLO
import json
from google.cloud import storage
import io
import os
import contextlib
import requests
from dotenv import load_dotenv

# Memuat variabel lingkungan dari file .env
load_dotenv()

# Ambil path credentials dari env GOOGLECLOUDCREDENTIALS (misal dari .env)
gcp_credentials = os.getenv("GOOGLECLOUDCREDENTIALS")
if gcp_credentials:
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = gcp_credentials

# Ambil token dan chat id Telegram dari env
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

# Ambil path gambar (bisa nama file lokal atau path GCS) dan model dari argumen
image_path = sys.argv[1]
model_path = sys.argv[2]

# Fungsi untuk membuka gambar dari GCS atau lokal       
def open_image(image_path):
    if image_path.startswith('gs://'):
        gcs_uri = image_path.replace('gs://', '')
        bucket_name, blob_name = gcs_uri.split('/', 1)
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        img_bytes = blob.download_as_bytes()
        return Image.open(io.BytesIO(img_bytes))
    else:
        return Image.open(image_path)

# Memuat model YOLOv8 dari file .pt
model = YOLO(model_path)

# Membuka gambar untuk deteksi (dari GCS atau lokal)
img = open_image(image_path)

# Melakukan deteksi objek, suppress log ke stderr
with contextlib.redirect_stdout(sys.stderr):
    results = model(img)
result = results[0]  # Ambil hasil pertama

# Output deteksi objek dalam format JSON (hanya ini ke stdout)
detections_json = result.to_json()
print(detections_json)

# --- Tambahan: Simpan gambar dengan kotak deteksi ---
annotated_img = result.plot()  # Numpy array
img_pil = Image.fromarray(annotated_img)
output_path = "detected_output.jpg"
img_pil.save(output_path)

# --- Kirim ke Telegram ---
def send_telegram_photo(photo_path, caption=None):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("[ERROR] TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum di-set di environment.", file=sys.stderr)
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    with open(photo_path, "rb") as photo_file:
        files = {"photo": photo_file}
        data = {"chat_id": TELEGRAM_CHAT_ID}
        if caption:
            data["caption"] = caption
        response = requests.post(url, files=files, data=data)
        if response.status_code == 200:
            print("[INFO] Foto berhasil dikirim ke Telegram.", file=sys.stderr)
        else:
            print(f"[ERROR] Gagal kirim foto ke Telegram: {response.text}", file=sys.stderr)

send_telegram_photo(output_path, "Hasil deteksi pakan ikan")    