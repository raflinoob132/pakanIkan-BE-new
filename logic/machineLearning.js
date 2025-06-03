const { exec } = require('child_process');
const fs = require('fs');
const { sendTelegramImage } = require('../telegram/telegramUtils');
const { bucket } = require('../config/storage');
const path = require('path');

async function processImage(buffer, fileName) {
  const modelPath = path.join(__dirname, 'model_pakan-ikan-akhir.pt');

  // Cek apakah model sudah ada di lokal
  if (!fs.existsSync(modelPath)) {
    const modelBuffer = await loadModelFromGCS();
    fs.writeFileSync(modelPath, modelBuffer);
  }

  // Gunakan path GCS untuk gambar
  const gcsImagePath = `gs://pakan-ikan123/${fileName}`;
  console.log(`[DEBUG] Akan menjalankan: python detect_objects.py "${gcsImagePath}" "${modelPath}"`);

  return new Promise((resolve, reject) => {
    exec(
      `python detect_objects.py "${gcsImagePath}" "${modelPath}"`,
      { env: process.env }, // <-- Tambahkan baris ini!
      async (err, stdout, stderr) => {
        if (err) {
          console.error('[DEBUG] Deteksi gagal:', stderr);
          return reject(err);
        }

      console.log('[DEBUG] Hasil deteksi dari Python:', stdout);

      // Ambil hanya bagian JSON dari output Python
      const jsonMatch = stdout.match(/\[\s*{[\s\S]*}\s*\]/);
      if (!jsonMatch) {
        console.error('[DEBUG] Tidak menemukan JSON pada output:', stdout);
        return reject(new Error('No JSON found in Python output'));
      }

      let detectedFishFoodCount = 0;
      try {
        detectedFishFoodCount = countFishFood(jsonMatch[0]);
      } catch (parseErr) {
        console.error('[DEBUG] Gagal parsing hasil deteksi:', parseErr, jsonMatch[0]);
        return reject(parseErr);
      }

      let statusMessage = 'Pakan masih banyak';
      let makananHabis = false;
      if (detectedFishFoodCount <= 10) {
        statusMessage = 'Pakan habis/hampir habis';
        makananHabis = true;
      }

      // Kirim hasil ke Telegram
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
async function loadModelFromGCS(modelFileName = 'model_pakan-ikan-akhir.pt') {
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

// ...fungsi countFishFood dan module.exports tetap...

// Fungsi untuk menghitung jumlah objek "pakan ikan" yang terdeteksi
function countFishFood(detectedObjects) {
  // Misal deteksi menghasilkan JSON array
  const objects = JSON.parse(detectedObjects);
  let fishFoodCount = 0;
  objects.forEach(obj => {
    if (obj.name === 'pakan_ikan') { // Ganti label sesuai model Anda
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