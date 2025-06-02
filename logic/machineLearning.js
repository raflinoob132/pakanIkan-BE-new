const { exec } = require('child_process');
const axios = require('axios');
const fs = require('fs');

// Fungsi untuk mendeteksi objek menggunakan YOLOv8 dengan PyTorch
async function processImage(buffer, fileName) {
  // URL model YOLOv8 di GCS
  const modelUrl = 'https://storage.googleapis.com/pakan-ikan123/yolov8_model.pth';  // Ganti dengan URL model Anda
  
  // Memuat model langsung dari GCS
  const model = await loadModelFromGCS(modelUrl);

  // Jalankan deteksi objek menggunakan model YOLOv8
  exec(`python detect_objects.py ${fileName} ${model}`, async (err, stdout, stderr) => {
    if (err) {
      console.error('Deteksi gagal:', stderr);
      return;
    }

    console.log('Hasil deteksi:', stdout);

    // Ekstrak informasi jumlah objek "pakan ikan" yang terdeteksi
    const detectedFishFoodCount = countFishFood(stdout);  // Fungsi untuk menghitung pakan ikan

    let statusMessage = 'Pakan masih banyak';  // Default status
    if (detectedFishFoodCount <= 10) {
      statusMessage = 'Pakan habis/hampir habis';
      
    }

    // Kirim gambar hasil deteksi dan status pakan ke Telegram
    await sendTelegramImage(`https://storage.googleapis.com/${bucketName}/${fileName}`, `Hasil deteksi objek: ${statusMessage}`);
    // bot.sendPhoto(chatId, buffer, {
    //   caption: `Hasil deteksi objek: ${statusMessage}`,
    // })
    // .then(() => console.log('Gambar hasil deteksi berhasil dikirim ke Telegram'))
    // .catch(err => console.error('Gagal mengirim gambar:', err));
  });
}

// Fungsi untuk memuat model YOLOv8 langsung dari GCS
async function loadModelFromGCS(modelUrl) {
  const { Readable } = require('stream');
  
  // Mendapatkan file model dari GCS
  const file = bucket.file('model_pakan-ikan-akhir.pth');  // Ganti dengan nama file model Anda
  const fileStream = file.createReadStream();

  // Mengubah stream ke buffer
  const chunks = [];
  fileStream.on('data', chunk => chunks.push(chunk));
  fileStream.on('end', () => {
    const modelBuffer = Buffer.concat(chunks);
    const model = torch.load(modelBuffer);  // Muat model dari buffer menggunakan PyTorch
    console.log('Model berhasil dimuat');
  });

  return model;
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
exports = {
  processImage,
  loadModelFromGCS,
  countFishFood
};