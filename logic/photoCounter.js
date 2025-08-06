// photoCounter.js - Shared photo transaction counter
let totalPhotoSizeBytes = 0;
let photoTransactionCount = 0;

// Transaction types untuk tracking yang lebih detail
const transactionTypes = {
  UPLOAD_ORIGINAL: 'upload_original',
  UPLOAD_PROCESSED: 'upload_processed', 
  DOWNLOAD: 'download',
  USER_REQUEST_ORIGINAL: 'user_request_original',
  USER_REQUEST_PROCESSED: 'user_request_processed',
  SECURITY_PHOTO: 'security_photo',
  TELEGRAM_SEND: 'telegram_send'
};

// Detailed counter per type (optional untuk analytics)
const transactionByType = {};

// Initialize counters for each type
Object.values(transactionTypes).forEach(type => {
  transactionByType[type] = { count: 0, totalBytes: 0 };
});

// Fungsi untuk menambah ukuran foto ke counter
const addPhotoSize = (sizeInBytes, operation = 'unknown') => {
  totalPhotoSizeBytes += sizeInBytes;
  photoTransactionCount++;
  
  // Track by type if valid
  if (transactionByType[operation]) {
    transactionByType[operation].count++;
    transactionByType[operation].totalBytes += sizeInBytes;
  }
  
  console.log(`[${operation.toUpperCase()}] Photo size: ${(sizeInBytes / 1024).toFixed(2)} KB`);
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

// Fungsi untuk mendapatkan statistik detail per type
const getDetailedPhotoStats = () => {
  const basicStats = getPhotoStats();
  const detailedByType = {};
  
  Object.entries(transactionByType).forEach(([type, data]) => {
    if (data.count > 0) {
      detailedByType[type] = {
        count: data.count,
        totalSizeKB: (data.totalBytes / 1024).toFixed(2),
        averageSizeKB: (data.totalBytes / 1024 / data.count).toFixed(2)
      };
    }
  });
  
  return {
    ...basicStats,
    byType: detailedByType
  };
};

// Fungsi untuk reset counter (jika diperlukan)
const resetPhotoCounter = () => {
  totalPhotoSizeBytes = 0;
  photoTransactionCount = 0;
  Object.values(transactionTypes).forEach(type => {
    transactionByType[type] = { count: 0, totalBytes: 0 };
  });
  console.log('Photo counter has been reset');
};

module.exports = {
  addPhotoSize,
  getPhotoStats,
  getDetailedPhotoStats,
  resetPhotoCounter,
  transactionTypes
};