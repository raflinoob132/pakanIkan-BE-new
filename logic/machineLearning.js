const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const {sendTelegramImage} = require('../telegram/telegramUtils');
const { Storage } = require('@google-cloud/storage');
const {bucket}= require('../config/storage');
// Fungsi untuk mendeteksi objek menggunakan YOLOv8 dengan PyTorch
async function processImage(buffer, fileName) {
  // DEBUG: Cek argumen yang akan dikirim ke Python
  console.log(`[DEBUG] Akan menjalankan: python detect_objects.py ${fileName} model_pakan-ikan-akhir.pth`);

  return new Promise((resolve, reject) => {
    exec(`python detect_objects.py ${fileName} model_pakan-ikan-akhir.pth`, async (err, stdout, stderr) => {
      if (err) {
        console.error('[DEBUG] Deteksi gagal:', stderr);
        return reject(err);
      }

      console.log('[DEBUG] Hasil deteksi dari Python:', stdout);

      let detectedFishFoodCount = 0;
      try {
        detectedFishFoodCount = countFishFood(stdout);
      } catch (parseErr) {
        console.error('[DEBUG] Gagal parsing hasil deteksi:', parseErr, stdout);
        return reject(parseErr);
      }

      let statusMessage = 'Pakan masih banyak';
      let makananHabis = false;
      if (detectedFishFoodCount <= 10) {
        statusMessage = 'Pakan habis/hampir habis';
        makananHabis = true;
      }

      // DEBUG: Info sebelum kirim ke Telegram
      console.log(`[DEBUG] Akan kirim ke Telegram: makananHabis=${makananHabis}, count=${detectedFishFoodCount}`);

      try {
        await sendTelegramImage(
          `https://storage.googleapis.com/pakan-ikan123/${fileName}`,
          `Hasil deteksi objek: ${statusMessage}`
        );
      } catch (sendErr) {
        console.error('[DEBUG] Gagal kirim gambar ke Telegram:', sendErr);
      }

      resolve({ detectedFishFoodCount, statusMessage, makananHabis });
    });
  });
}

// Fungsi untuk memuat model YOLOv8 langsung dari GCS
async function loadModelFromGCS(modelFileName = 'model_pakan-ikan-akhir.pth') {
  const { Readable } = require('stream');
  try {
    console.log(`[DEBUG] Mulai download model dari GCS: ${modelFileName}`);
    const file = bucket.file(modelFileName);
    const chunks = [];
    return await new Promise((resolve, reject) => {
      const fileStream = file.createReadStream();
      fileStream.on('data', chunk => {
        chunks.push(chunk);
        console.log(`[DEBUG] Mendapat chunk model, size: ${chunk.length}`);
      });
      fileStream.on('end', () => {
        const modelBuffer = Buffer.concat(chunks);
        console.log(`[DEBUG] Model berhasil di-download, total size: ${modelBuffer.length}`);
        // Tidak bisa torch.load di Node.js, return buffer saja
        resolve(modelBuffer);
      });
      fileStream.on('error', (err) => {
        console.error('[DEBUG] Gagal download model dari GCS:', err);
        reject(err);
      });
    });
  } catch (err) {
    console.error('[DEBUG] Error di loadModelFromGCS:', err);
    throw err;
  }
}

// Fungsi untuk menghitung jumlah objek "pakan ikan" yang terdeteksi
function countFishFood(detectedObjects) {
  // Misalnya, kita asumsikan objek "pakan ikan" memiliki label tertentu, seperti "fish_food"
  // Anda bisa mengganti kode ini untuk menyesuaikan dengan hasil keluaran model YOLOv8
  const objects = JSON.parse(detectedObjects);  // Misalnya deteksi menghasilkan JSON
  let fishFoodCount = 0;
  
  objects.forEach(obj => {
    if (obj.label === 'pakan_ikan') {  // Ganti 'fish_food' sesuai dengan label yang relevan
      fishFoodCount += 1;
    }
  });

  return fishFoodCount;
}
module.exports = {
  processImage,
  loadModelFromGCS,
  countFishFood
};