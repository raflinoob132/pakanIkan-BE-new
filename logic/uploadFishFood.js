const { Storage } = require('@google-cloud/storage');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');

// Inisialisasi Google Cloud Storage
const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
});
const bucketName = 'pakan-ikan123';
const bucket = storage.bucket(bucketName);

// Set token bot Telegram Anda
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const bot = new TelegramBot(token, { polling: true });

// Fungsi handler untuk upload gambar ke Google Cloud Storage
const uploadFishFoodImageToGCS = async (req, res) => {
  try {
    const buffer = req.body;  // Gambar yang di-upload (buffer)

    // Putar gambar 180 derajat menggunakan sharp
    const rotatedBuffer = await sharp(buffer)
      .rotate(180)
      .jpeg({ quality: 90 })  // Optional: kompresi
      .toBuffer();

    const fileName = `photo_${Date.now()}.jpg`;
    const file = bucket.file(fileName);

    // Upload gambar ke GCS
    await file.save(rotatedBuffer, {
      metadata: {
        contentType: 'image/jpeg',
      },
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log('Uploaded to:', publicUrl);

    // Proses gambar dengan YOLOv8 dan kirim hasil deteksi ke Telegram
    await processImage(rotatedBuffer, fileName);

    res.status(200).json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Error uploading to GCS:', err);
    res.status(500).send('Upload failed');
  }
};

// Fungsi untuk mendeteksi objek menggunakan YOLOv8 dengan PyTorch
async function processImage(buffer, fileName) {
  // URL model YOLOv8 di GCS
  const modelUrl = 'https://storage.googleapis.com/pakan-ikan123/yolov8_model.pth';  // Ganti dengan URL model Anda
  
  // Memuat model langsung dari GCS
  const model = await loadModelFromGCS(modelUrl);

  // Jalankan deteksi objek menggunakan model YOLOv8
  exec(`python detect_objects.py ${fileName} ${model}`, (err, stdout, stderr) => {
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
    bot.sendPhoto(chatId, buffer, {
      caption: `Hasil deteksi objek: ${statusMessage}`,
    })
    .then(() => console.log('Gambar hasil deteksi berhasil dikirim ke Telegram'))
    .catch(err => console.error('Gagal mengirim gambar:', err));
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

// Ekspos fungsi upload
module.exports = { uploadFishFoodImageToGCS };


// const fs = require('fs');
// const path = require('path');
// const sharp = require('sharp'); // <- tambahkan ini

// // Fungsi upload foto ke folder lokal
// const uploadFishFoodToLocal = async (req, res) => {
//   try {
//     const buffer = req.body; // buffer dari image
//     const fileName = `photo_${Date.now()}.jpg`;
//     const uploadDir = path.join(__dirname, '../uploads/fishFood');

//     // Pastikan folder uploads ada
//     if (!fs.existsSync(uploadDir)) {
//       fs.mkdirSync(uploadDir, { recursive: true });
//     }

//     const filePath = path.join(uploadDir, fileName);

//     // Gunakan sharp untuk memutar gambar 180 derajat dan simpan ke file
//     await sharp(buffer)
//       .rotate(180) // <- memutar 180 derajat
//       .toFile(filePath);

//     console.log('Uploaded and rotated image to local:', filePath);
//     res.status(200).json({ success: true, path: filePath });
//   } catch (err) {
//     console.error('Error uploading/rotating image:', err);
//     res.status(500).send('Upload failed');
//   }
// };

// module.exports = { uploadFishFoodToLocal };
