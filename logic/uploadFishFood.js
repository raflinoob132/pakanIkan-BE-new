const fs = require('fs');
const path = require('path');

// Fungsi upload foto ke folder lokal
const uploadFishFoodToLocal = async (req, res) => {
  try {
    const buffer = req.body;
    const fileName = `photo_${Date.now()}.jpg`;
    const uploadDir = path.join(__dirname, '../uploads/fishFood');

    // Pastikan folder uploads ada
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = path.join(uploadDir, fileName);
    
    // Tulis file ke lokal
    fs.writeFileSync(filePath, buffer);

    console.log('Uploaded to local:', filePath);
    res.status(200).json({ success: true, path: filePath });
  } catch (err) {
    console.error('Error uploading to local:', err);
    res.status(500).send('Upload failed');
  }
};

module.exports = { uploadFishFoodToLocal };
