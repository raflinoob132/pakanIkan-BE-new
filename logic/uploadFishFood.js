const { Storage } = require('@google-cloud/storage');
const path = require('path');
const sharp = require('sharp'); // Tambahkan ini

// Inisialisasi Google Cloud Storage
const storage = new Storage({
  keyFilename: path.join(__dirname, '../credentials/vibrant-period-457006-b5-a3522b826a94.json'),
});
const bucketName = 'pakan-ikan';
const bucket = storage.bucket(bucketName);

// Fungsi handler untuk upload gambar
const uploadFishFoodImageToGCS = async (req, res) => {
  try {
    const buffer = req.body;

    // Putar gambar 180 derajat menggunakan sharp
    const rotatedBuffer = await sharp(buffer)
      .rotate(180)
      .jpeg({ quality: 90 }) // Optional: kompresi
      .toBuffer();

    const fileName = `photo_${Date.now()}.jpg`;
    const file = bucket.file(fileName);

    await file.save(rotatedBuffer, {
      metadata: {
        contentType: 'image/jpeg',
      },
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
    console.log('Uploaded to:', publicUrl);
    res.status(200).json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Error uploading to GCS:', err);
    res.status(500).send('Upload failed');
  }
};

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
