# --- Bagian Node.js ---
FROM node:22.13.1 AS node

# Set working directory untuk aplikasi Node.js
WORKDIR /app

# Menyalin package.json dan package-lock.json ke dalam container
COPY package*.json ./

# Install dependensi aplikasi Node.js
RUN npm install

# Menyalin seluruh file proyek Node.js ke dalam container
COPY . .

# --- Bagian Python untuk YOLOv8 ---
FROM python:3.9-slim AS python

# Set working directory untuk Python
WORKDIR /app

# Menyalin file requirements.txt untuk Python
COPY requirements.txt .

# Install dependensi Python untuk YOLOv8
RUN pip install --no-cache-dir -r requirements.txt

# Menyalin file deteksi objek Python dan model YOLOv8 ke dalam container
COPY detect_objects.py /app/
COPY logic/model_pakan-ikan-akhir.pt /app/models/

# --- Menggabungkan Layer untuk Node.js dan Python ---
FROM node:16 AS final

# Set working directory untuk aplikasi final
WORKDIR /app

# Menyalin hasil build dari image node
COPY --from=node /app /app

# Menyalin file deteksi objek dan model dari image Python
COPY --from=python /app/detect_objects.py /app/
COPY --from=python /app/models /app/models

# Mengekspos port yang akan digunakan oleh aplikasi
EXPOSE 8080

# Menjalankan aplikasi Node.js menggunakan Gunicorn atau PM2
CMD ["npm", "start"]
