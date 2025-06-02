import sys
import torch
from PIL import Image
from ultralytics import YOLO
from google.cloud import storage
from io import BytesIO

# Fungsi untuk mengunduh gambar dari GCS
def download_image_from_gcs(bucket_name, image_name):
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(image_name)

    # Mengunduh gambar ke memori
    image_bytes = blob.download_as_bytes()
    return Image.open(BytesIO(image_bytes))  # Mengembalikan gambar sebagai PIL Image

# Fungsi untuk mengunduh model dari GCS ke memori
def download_model_from_gcs(bucket_name, model_name):
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(model_name)

    # Mengunduh model ke buffer memori
    model_bytes = blob.download_as_bytes()
    return model_bytes

# Fungsi untuk memuat model dari buffer memori
def load_model_from_bytes(model_bytes):
    model = torch.load(BytesIO(model_bytes))
    model.eval()  # Set model ke mode evaluasi
    return model

# Ambil path gambar dan model dari argumen
image_name = sys.argv[1]
model_name = sys.argv[2]

# Nama bucket GCS tempat gambar dan model disimpan
bucket_name = 'pakan-ikan123'  # Ganti dengan nama bucket Anda

# Mengunduh model dari GCS
try:
    model_bytes = download_model_from_gcs(bucket_name, model_name)
    model = load_model_from_bytes(model_bytes)
except Exception as e:
    print(f"[ERROR] Gagal mengunduh model dari GCS: {e}")
    sys.exit(1)

# Mengunduh gambar dari GCS
try:
    img = download_image_from_gcs(bucket_name, image_name)
except Exception as e:
    print(f"[ERROR] Gagal mengunduh gambar dari GCS: {e}")
    sys.exit(1)

# Melakukan deteksi objek
results = model(img)

# Menghasilkan hasil deteksi dalam format JSON
detections = results.pandas().xywh  # Hasil deteksi dalam format pandas DataFrame
detections_json = detections.to_json(orient="records")  # Convert to JSON

# Output deteksi objek dalam format JSON
print(detections_json)
