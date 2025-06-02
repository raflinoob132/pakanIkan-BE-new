const { Storage } = require('@google-cloud/storage');
const path = require('path');
const sharp = require('sharp');
const { sendTelegramImage } = require('../telegram/telegramUtils');
const { processImage } = require('./machineLearning');
let isNewPhotoUploaded = false; // Penanda global

const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/cloud-storage-access.json'),
});
const bucketName = 'pakan-ikan123';
const bucket = storage.bucket(bucketName);

// Fungsi handler untuk upload gambar ke Google Cloud Storage
const uploadFishFoodImageToGCS = async (req, res) => {
  try {
    const buffer = req.body;

    // Putar gambar 180 derajat menggunakan sharp
    const rotatedBuffer = await sharp(buffer)
      .rotate(180)
      .jpeg({ quality: 90 })
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
    isNewPhotoUploaded = true; // Set penanda setelah upload sukses

    // Proses gambar dengan YOLOv8 dan kirim hasil deteksi ke Telegram
    // await processImage(rotatedBuffer, fileName);

    res.status(200).json({ success: true, url: publicUrl });
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
  return { buffer, fileName: latestFile.name };
}

module.exports = { uploadFishFoodImageToGCS, getLatestPhotoFromGCS };