const { Storage } = require('@google-cloud/storage');
const path = require('path');
const sharp = require('sharp');
const { sendTelegramImage } = require('../telegram/telegramUtils');
const { processImage } = require('./machineLearning');

let isNewPhotoUploaded = false; // Penanda global

// Counter untuk melacak total ukuran transaksi foto
let totalPhotoSizeBytes = 0;
let photoTransactionCount = 0;

const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
});
const bucketName = 'pakan-ikan1234';
const bucket = storage.bucket(bucketName);

// Fungsi untuk menambah ukuran foto ke counter
const addPhotoSize = (sizeInBytes, operation = 'upload') => {
  totalPhotoSizeBytes += sizeInBytes;
  photoTransactionCount++;
  console.log(`[${operation}] Photo size: ${(sizeInBytes / 1024).toFixed(2)} KB`);
  console.log(`Total photos processed: ${photoTransactionCount}`);
  console.log(`Total size: ${(totalPhotoSizeBytes / 1024).toFixed(2)} KB`);
};

// Fungsi untuk mendapatkan statistik ukuran foto
const getPhotoStats = () => {
  return {
    totalSizeKB: (totalPhotoSizeBytes / 1024).toFixed(2),
    totalSizeMB: (totalPhotoSizeBytes / (1024 * 1024)).toFixed(2),
    totalTransactions: photoTransactionCount,
    averageSizeKB: photoTransactionCount > 0 ? 
      (totalPhotoSizeBytes / 1024 / photoTransactionCount).toFixed(2) : 0
  };
};

// Fungsi handler untuk upload gambar ke Google Cloud Storage
const uploadFishFoodImageToGCS = async (req, res) => {
  try {
    const buffer = req.body;
    
    // Tambahkan ukuran buffer original ke counter
    addPhotoSize(buffer.length, transactionTypes.UPLOAD_ORIGINAL);

    // Putar gambar 180 derajat menggunakan sharp
    const rotatedBuffer = await sharp(buffer)
      .rotate(180)
      .jpeg({ quality: 90 })
      .toBuffer();

    // Tambahkan ukuran buffer yang sudah diproses ke counter
    addPhotoSize(rotatedBuffer.length, transactionTypes.UPLOAD_PROCESSED);

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
    isNewPhotoUploaded = true; // Set penanda setelah upload sukses

    // Log statistik saat ini
    const stats = getPhotoStats();
    console.log('=== PHOTO TRANSACTION STATS ===');
    console.log(`Total Size: ${stats.totalSizeKB} KB (${stats.totalSizeMB} MB)`);
    console.log(`Total Transactions: ${stats.totalTransactions}`);
    console.log(`Average Size: ${stats.averageSizeKB} KB per photo`);
    console.log('===============================');

    // Proses gambar dengan YOLOv8 dan kirim hasil deteksi ke Telegram
    // await processImage(rotatedBuffer, fileName);

    res.status(200).json({ 
      success: true, 
      url: publicUrl,
      photoStats: stats
    });
  } catch (err) {
    console.error('Error uploading to GCS:', err);
    res.status(500).send('Upload failed');
  }
};

// Fungsi untuk mengambil foto terbaru dari GCS
async function getLatestPhotoFromGCS() {
  while (!isNewPhotoUploaded) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  isNewPhotoUploaded = false; // Reset penanda setelah mengambil foto
  const [files] = await bucket.getFiles({ prefix: 'photo_' });
  if (!files.length) return null;
  
  // Urutkan berdasarkan timestamp pada nama file
  files.sort((a, b) => {
    const aTime = parseInt(a.name.match(/\d+/)?.[0] || "0");
    const bTime = parseInt(b.name.match(/\d+/)?.[0] || "0");
    return bTime - aTime;
  });
  
  const latestFile = files[0];
  const [buffer] = await latestFile.download();
  
  // Tambahkan ukuran download ke counter
  addPhotoSize(buffer.length, transactionTypes.DOWNLOAD);
  
  return { buffer, fileName: latestFile.name };
}

async function sendUserRequestPhoto(buffer, bot, chatId) {
  // Tambahkan ukuran buffer original ke counter
  addPhotoSize(buffer.length, transactionTypes.USER_REQUEST_ORIGINAL);

  // Putar 180 derajat menggunakan sharp
  const rotatedBuffer = await sharp(buffer)
    .rotate(180)
    .jpeg({ quality: 80 })
    .toBuffer();

  // Tambahkan ukuran buffer yang sudah diproses ke counter
  addPhotoSize(rotatedBuffer.length, transactionTypes.USER_REQUEST_PROCESSED);

  // Kirim ke Telegram
  await bot.sendPhoto(chatId, rotatedBuffer, { caption: 'Foto request user' });

  // Upload ke GCS
  const fileName = `photo_${Date.now()}.jpg`;
  const file = bucket.file(fileName);
  await file.save(rotatedBuffer, {
    metadata: {
      contentType: 'image/jpeg',
    },
  });

  // Set penanda agar getLatestPhotoFromGCS bisa mendeteksi foto baru
  isNewPhotoUploaded = true;

  // Buat URL publik
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
  console.log('user request photo uploaded to GCS:', publicUrl);

  // Log statistik saat ini
  const stats = getPhotoStats();
  console.log('=== PHOTO TRANSACTION STATS (User Request) ===');
  console.log(`Total Size: ${stats.totalSizeKB} KB (${stats.totalSizeMB} MB)`);
  console.log(`Total Transactions: ${stats.totalTransactions}`);
  console.log(`Average Size: ${stats.averageSizeKB} KB per photo`);
  console.log('==============================================');

  return publicUrl;
}

// Endpoint untuk mendapatkan statistik foto (opsional)
const getPhotoStatsEndpoint = (req, res) => {
  const basicStats = getPhotoStats();
  const detailedStats = getDetailedPhotoStats();
  
  res.json({
    message: 'Photo transaction statistics',
    basic: basicStats,
    detailed: detailedStats,
    rawData: {
      totalSizeBytes: parseFloat(basicStats.totalSizeKB) * 1024,
      totalSizeKB: parseFloat(basicStats.totalSizeKB),
      totalSizeMB: parseFloat(basicStats.totalSizeMB),
      totalTransactions: basicStats.totalTransactions,
      averageSizeKB: parseFloat(basicStats.averageSizeKB)
    }
  });
};

module.exports = { 
  sendUserRequestPhoto, 
  uploadFishFoodImageToGCS, 
  getLatestPhotoFromGCS,
  getPhotoStatsEndpoint
};
// const { Storage } = require('@google-cloud/storage');
// const path = require('path');
// const sharp = require('sharp');
// const { sendTelegramImage } = require('../telegram/telegramUtils');
// const { processImage } = require('./machineLearning');
// let isNewPhotoUploaded = false; // Penanda global

// const storage = new Storage({
//   keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
// });
// const bucketName = 'pakan-ikan1234';
// const bucket = storage.bucket(bucketName);

// // Fungsi handler untuk upload gambar ke Google Cloud Storage
// const uploadFishFoodImageToGCS = async (req, res) => {
//   try {
//     const buffer = req.body;

//     // Putar gambar 180 derajat menggunakan sharp
//     const rotatedBuffer = await sharp(buffer)
//       .rotate(180)
//       .jpeg({ quality: 90 })
//       .toBuffer();

//     const fileName = `photo_${Date.now()}.jpg`;
//     const file = bucket.file(fileName);

//     // Upload gambar ke GCS
//     await file.save(rotatedBuffer, {
//       metadata: {
//         contentType: 'image/jpeg',
//       },
//     });

//     const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
//     console.log('Uploaded to:', publicUrl);
//     isNewPhotoUploaded = true; // Set penanda setelah upload sukses

//     // Proses gambar dengan YOLOv8 dan kirim hasil deteksi ke Telegram
//     // await processImage(rotatedBuffer, fileName);

//     res.status(200).json({ success: true, url: publicUrl });
//   } catch (err) {
//     console.error('Error uploading to GCS:', err);
//     res.status(500).send('Upload failed');
//   }
// };

// // Fungsi untuk mengambil foto terbaru dari GCS
// async function getLatestPhotoFromGCS() {
//   while (!isNewPhotoUploaded) {
//     await new Promise(resolve => setTimeout(resolve, 500));
//   }
//   isNewPhotoUploaded = false; // Reset penanda setelah mengambil foto
//   const [files] = await bucket.getFiles({ prefix: 'photo_' });
//   if (!files.length) return null;
//   // Urutkan berdasarkan timestamp pada nama file
//   files.sort((a, b) => {
//     const aTime = parseInt(a.name.match(/\d+/)?.[0] || "0");
//     const bTime = parseInt(b.name.match(/\d+/)?.[0] || "0");
//     return bTime - aTime;
//   });
//   const latestFile = files[0];
//   const [buffer] = await latestFile.download();
//   return { buffer, fileName: latestFile.name };
// }
// async function sendUserRequestPhoto(buffer, bot, chatId) {
//   // Putar 180 derajat menggunakan sharp
//   const rotatedBuffer = await sharp(buffer)
//     .rotate(180)
//     .jpeg({ quality: 80 })
//     .toBuffer();

//   // Kirim ke Telegram
//   await bot.sendPhoto(chatId, rotatedBuffer, { caption: 'Foto request user' });

//   // Upload ke GCS
//   const fileName = `photo_${Date.now()}.jpg`;
//   const file = bucket.file(fileName);
//   await file.save(rotatedBuffer, {
//     metadata: {
//       contentType: 'image/jpeg',
//     },
//   });

//   // Set penanda agar getLatestPhotoFromGCS bisa mendeteksi foto baru
//   isNewPhotoUploaded = true;

//   // Buat URL publik
//   const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
//   console.log('user request photo uploaded to GCS:', publicUrl);

//   return publicUrl;
// }
// module.exports = { sendUserRequestPhoto, uploadFishFoodImageToGCS, getLatestPhotoFromGCS };