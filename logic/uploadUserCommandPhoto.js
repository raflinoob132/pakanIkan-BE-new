const sharp = require('sharp');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

// Konfigurasi GCS
const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
});
const bucketName = 'pakan-ikan123';
const bucket = storage.bucket(bucketName);

// Fungsi kirim foto ke Telegram dan upload ke GCS
async function sendUserRequestPhoto(buffer, bot, chatId) {
  // Putar 180 derajat menggunakan sharp
  const rotatedBuffer = await sharp(buffer)
    .rotate(180)
    .jpeg({ quality: 80 })
    .toBuffer();

  // Kirim ke Telegram
  await bot.sendPhoto(chatId, rotatedBuffer, { caption: 'Foto request user' });

  // Upload ke GCS
  const fileName = `security_${Date.now()}.jpg`;
  const file = bucket.file(fileName);
  await file.save(rotatedBuffer, {
    metadata: {
      contentType: 'image/jpeg',
    },
  });

  // Buat URL publik
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
  console.log('Security photo uploaded to GCS:', publicUrl);

  return publicUrl;
}

module.exports = { sendUserRequestPhoto };