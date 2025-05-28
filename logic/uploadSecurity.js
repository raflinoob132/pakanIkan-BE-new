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
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dn1b60nhb',
  api_key: '974149127748847',
  api_secret: 'u_1MbxouXkih9M4NgPs0pBlUeUQ',
});

const uploadSecurityPhotoToCloudinary = async (req, res) => {
  try {
    const buffer = req.body;
    const base64Str = buffer.toString('base64');
    const dataUri = `data:image/jpeg;base64,${base64Str}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'securityPhoto'
    });

    console.log('Uploaded to Cloudinary:', result.secure_url);
    res.status(200).json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Upload to Cloudinary failed:', err);
    res.status(500).send('Upload failed');
  }
};

module.exports = { uploadSecurityPhotoToCloudinary };
