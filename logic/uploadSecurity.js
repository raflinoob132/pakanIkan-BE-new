const sharp = require('sharp');
const { addPhotoSize, getPhotoStats, transactionTypes } = require('./photoCounter');

async function sendSecurityPhotoToTelegram(buffer, bot, chatId) {
  // Track original buffer size
  addPhotoSize(buffer.length, transactionTypes.SECURITY_PHOTO);
  
  // Putar 180 derajat menggunakan sharp
  const rotatedBuffer = await sharp(buffer)
    .rotate(180)
    .jpeg({ quality: 80 })
    .toBuffer();

  // Track processed buffer size
  addPhotoSize(rotatedBuffer.length, transactionTypes.TELEGRAM_SEND);

  // Kirim ke Telegram
  await bot.sendPhoto(chatId, rotatedBuffer, { caption: 'Ancaman terdeteksi. ini adalah fotonya' });

  // Log current stats
  const stats = getPhotoStats();
  console.log('=== SECURITY PHOTO STATS ===');
  console.log(`Total Size: ${stats.totalSizeKB} KB (${stats.totalSizeMB} MB)`);
  console.log(`Total Transactions: ${stats.totalTransactions}`);
  console.log(`Average Size: ${stats.averageSizeKB} KB per photo`);
  console.log('============================');
}

module.exports = { sendSecurityPhotoToTelegram };
// const sharp = require('sharp');

// // Pastikan bot dan chatId di-import atau di-passing ke fungsi ini

// // Fungsi murni untuk kirim foto ke Telegram
// async function sendSecurityPhotoToTelegram(buffer, bot, chatId) {
//   // Putar 180 derajat menggunakan sharp
//   const rotatedBuffer = await sharp(buffer)
//     .rotate(180)
//     .jpeg({ quality: 80 })
//     .toBuffer();

//   // Kirim ke Telegram
//   await bot.sendPhoto(chatId, rotatedBuffer, { caption: 'Ancaman terdeteksi. ini adalah fotonya' });
// }

// module.exports = { sendSecurityPhotoToTelegram };
// const fs = require('fs');
// const path = require('path');

// // Fungsi upload foto ke folder lokal
// const uploadSecurityPhotoToLocal = async (req, res) => {
//   try {
//     const buffer = req.body;
//     const fileName = `photo_${Date.now()}.jpg`;
//     const uploadDir = path.join(__dirname, '../uploads/securityPhoto');

//     // Pastikan folder uploads ada
//     if (!fs.existsSync(uploadDir)) {
//       fs.mkdirSync(uploadDir, { recursive: true });
//     }

//     const filePath = path.join(uploadDir, fileName);
    
//     // Tulis file ke lokal
//     fs.writeFileSync(filePath, buffer);

//     console.log('Uploaded to local:', filePath);
//     res.status(200).json({ success: true, path: filePath });
//   } catch (err) {
//     console.error('Error uploading to local:', err);
//     res.status(500).send('Upload failed');
//   }
// };

// module.exports = { uploadSecurityPhotoToLocal };
// const cloudinary = require('cloudinary').v2;
// const sharp = require('sharp');

// // Konfigurasi Cloudinary
// cloudinary.config({
//   cloud_name: 'dn1b60nhb',
//   api_key: '974149127748847',
//   api_secret: 'u_1MbxouXkih9M4NgPs0pBlUeUQ',
// });

// // Fungsi upload ke Cloudinary dengan rotasi 180 derajat
// const uploadSecurityPhotoToCloudinary = async (req, res) => {
//   try {
//     const buffer = req.body; // Buffer dari ESP32-CAM

//     // Putar 180 derajat menggunakan sharp
//     const rotatedBuffer = await sharp(buffer)
//       .rotate(180)
//       .jpeg({ quality: 80 }) // Optional: kompresi ringan
//       .toBuffer();

//     // Ubah menjadi Data URI (base64) agar bisa diupload ke Cloudinary
//     const base64Str = rotatedBuffer.toString('base64');
//     const dataUri = `data:image/jpeg;base64,${base64Str}`;

//     // Upload ke folder "securityPhoto"
//     const result = await cloudinary.uploader.upload(dataUri, {
//       folder: 'securityPhoto',
//     });

//     console.log('Uploaded to Cloudinary:', result.secure_url);
//     res.status(200).json({ success: true, url: result.secure_url });
//   } catch (err) {
//     console.error('Upload to Cloudinary failed:', err);
//     res.status(500).send('Upload failed');
//   }
// };

// module.exports = { uploadSecurityPhotoToCloudinary };
