import sys
import torch
from PIL import Image
from ultralytics import YOLO
import json

# Ambil path gambar dan model dari argumen
image_path = sys.argv[1]
model_path = sys.argv[2]

# Memuat model YOLOv8 dari file .pth
model = YOLO(model_path)

# Membuka gambar untuk deteksi
img = Image.open(image_path)

# Melakukan deteksi objek
results = model(img)

# Menghasilkan hasil deteksi dalam format JSON
detections = results.pandas().xywh  # Hasil deteksi dalam format pandas DataFrame
detections_json = detections.to_json(orient="records")  # Convert to JSON

# Output deteksi objek dalam format JSON
print(detections_json)
