// /config/storage.js
require('dotenv').config();

const { Storage } = require('@google-cloud/storage');
const path = require('path');

// Menentukan path ke file kredensial JSON yang telah diunduh dari Google Cloud
const serviceAccountPath = path.join(__dirname, process.env.GCPCREDENTIALS);

// Inisialisasi Google Cloud Storage dengan kredensial
const storage = new Storage({
  keyFilename: serviceAccountPath
});

const bucketName = process.env.BUCKET_NAME;  // Ganti dengan nama bucket GCS Anda
const bucket = storage.bucket(bucketName);

module.exports = { storage, bucket };
