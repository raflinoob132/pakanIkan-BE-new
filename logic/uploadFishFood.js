const { Storage } = require('@google-cloud/storage');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { sendTelegramImage } = require('../telegram/telegramUtils');

// Inisialisasi Google Cloud Storage
const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
});
const bucketName = 'pakan-ikan123';
const bucket = storage.bucket(bucketName);

// Set token bot Telegram Anda
  // const token = process.env.TELEGRAM_BOT_TOKEN;
  // const chatId = process.env.TELEGRAM_CHAT_ID;
  // const bot = new TelegramBot(token, { polling: true });

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
