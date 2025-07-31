const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("./uploadFishFood");
const {storage, bucket} = require("../config/storage");

// Helper function to convert UTC to WIB (UTC+7) for consistent timezone handling
function toWIB(utcTimestamp) {
  return new Date(utcTimestamp + (7 * 60 * 60 * 1000));
}

// Helper function to get current time in WIB for logging
function getCurrentWIB() {
  return toWIB(Date.now());
}

// ============= QUEUE SYSTEM =============
class CameraFeedingQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentRequestId = null;
    this.failedRequests = new Map();
    this.photoReservations = new Map();
    this.lastSuccessfulCommand = null;
  }

  // Tambah request ke antrian
  async addRequest(servoCommand, purpose = "makanan") {
    return new Promise((resolve, reject) => {
      const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

      const request = {
        id: requestId,
        servoCommand,
        purpose,
        resolve,
        reject,
        timestamp: Date.now(),
        attempts: 0,
        maxAttempts: 3,
        createdAt: Date.now()
      };

      this.queue.push(request);
      console.log(`Request ${requestId} ditambahkan ke antrian. Queue length: ${this.queue.length} - Created at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);

      // Mulai pemrosesan jika belum jalan
      this.processQueue();
    });
  }

  // Proses antrian satu per satu dengan timeout protection
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      this.currentRequestId = request.id;
      
      console.log(`Memproses request ${request.id} - Servo: ${request.servoCommand} (attempt ${request.attempts + 1}/${request.maxAttempts})`);
      
      try {
        // Check if request is too old (older than 10 minutes)
        const requestAge = Date.now() - request.createdAt;
        if (requestAge > 10 * 60 * 1000) {
          throw new Error(`Request expired: ${Math.round(requestAge / 60000)} minutes old`);
        }

        // Check if this request has failed too many times before
        const failureKey = `${request.servoCommand}-${request.purpose}`;
        const recentFailures = this.getRecentFailures(failureKey);
        if (recentFailures >= 5) {
          throw new Error(`Too many recent failures for command ${request.servoCommand}. Skipping.`);
        }

        // PERBAIKAN: Cek dan bersihkan ESP32 sebelum mulai
        await this.prepareESP32ForNewCommand();

        // Get baseline photo before sending command (for logging purposes only)
        const baselinePhoto = await getLatestPhotoDirectFromGCS();
        const baselinePhotoId = baselinePhoto ? (baselinePhoto.name || baselinePhoto.fileName || baselinePhoto.id) : null;
        
        console.log(`📸 Baseline photo before command: ${baselinePhotoId}`);

        // Eksekusi request dengan timeout
        const result = await this.executeRequestWithTimeout(request, baselinePhotoId);
        request.resolve(result);
        
        console.log(`✅ Request ${request.id} berhasil diproses`);
        this.lastSuccessfulCommand = Date.now();
        
      } catch (error) {
        console.error(`❌ Request ${request.id} gagal:`, error.message);
        
        // Increment attempt counter
        request.attempts++;
        
        // Check if we should retry
        if (request.attempts < request.maxAttempts && 
            !error.message.includes('expired') && 
            !error.message.includes('Too many recent failures')) {
          
          console.log(`🔄 Retrying request ${request.id} (${request.attempts}/${request.maxAttempts})`);
          
          // Add back to front of queue for retry
          this.queue.unshift(request);
            
          // PERBAIKAN: Wait lebih lama dan reset ESP32 sebelum retry
          console.log(`⏳ Waiting 15 seconds before retry and resetting ESP32...`);
          await this.delay(15000);
          await this.forceResetESP32("Before retry");
          continue;
        }
        
        // Request failed permanently
        this.recordFailure(`${request.servoCommand}-${request.purpose}`);
        request.reject(error);
      } 
      
      // Reset current request
      this.currentRequestId = null;
      
      // Delay antar request untuk mencegah overload
      await this.delay(8000);
    }
    
    this.processing = false;
    console.log("✅ Semua request dalam antrian selesai diproses");
  }

  // BARU: Prepare ESP32 dan bersihkan state sebelum command baru
  async prepareESP32ForNewCommand() {
    console.log("🔧 Preparing ESP32 for new command...");
    
    try {
      // 1. Force reset camera_busy flag
      await db.ref("deviceStatus/camera_busy").set(false);
      console.log("🔧 Reset camera_busy to false");
      
      // 2. Clear any stale command
      await db.ref("checkCameraMoveCommand").set({
        commandId: null,
        moveServo: null,
        status: 0,
        timestamp: null,
        purpose: null
      });
      console.log("🔧 Cleared stale command data");
      
      // 3. Wait a bit for ESP32 to process
      await this.delay(2000);
      
      // 4. Final check if ESP32 is really ready
      const finalCheck = await this.checkESP32Status();
      if (finalCheck.isBusy) {
        console.log(`⚠️ ESP32 still busy after reset: ${finalCheck.reason}`);
        // Force it anyway since we already reset
      }
      
      console.log("✅ ESP32 preparation complete");
      
    } catch (error) {
      console.error("❌ Error preparing ESP32:", error.message);
      // Continue anyway, might still work
    }
  }

  // BARU: Force reset ESP32 state
  async forceResetESP32(reason = "Manual reset") {
    console.log(`🚨 Force resetting ESP32 state (${reason})...`);
    
    try {
      // Reset all ESP32 related flags
      await Promise.all([
        db.ref("deviceStatus/camera_busy").set(false),
        db.ref("checkCameraMoveCommand").set({
          commandId: null,
          moveServo: null,
          status: 0,
          timestamp: null,
          purpose: null
        })
      ]);
      
      console.log("✅ ESP32 state force reset complete");
      await this.delay(3000); // Wait for ESP32 to process reset
      
    } catch (error) {
      console.error("❌ Error force resetting ESP32:", error.message);
    }
  }

  // Execute request with overall timeout
  async executeRequestWithTimeout(request, baselinePhotoId) {
    const TOTAL_TIMEOUT = 180000; // 3 minutes total timeout per request (increased)
    
    return Promise.race([
      this.executeRequest(request, baselinePhotoId),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Request ${request.id} timeout after ${TOTAL_TIMEOUT}ms`)), TOTAL_TIMEOUT)
      )
    ]);
  }

  // PERBAIKAN: Cek status ESP32 dengan fallback
  async checkESP32Status() {
    try {
      // Get both status values
      const [cameraBusySnap, commandStatusSnap] = await Promise.all([
        db.ref("deviceStatus/camera_busy").once("value"),
        db.ref("checkCameraMoveCommand/status").once("value")
      ]);
      
      const isCameraBusy = cameraBusySnap.val() === true || cameraBusySnap.val() === "true";
      const commandStatus = commandStatusSnap.val();
      
      if (isCameraBusy) {
        return { isBusy: true, reason: "Camera sedang digunakan" };
      }

      if (commandStatus === 1) {
        return { isBusy: true, reason: "Masih ada command yang belum selesai" };
      }

      return { isBusy: false };
    } catch (error) {
      console.error("Error checking ESP32 status:", error.message);
      return { isBusy: false }; // Assume not busy if can't check
    }
  }

  // PERBAIKAN: Eksekusi request dengan multiple fallback strategies
  async executeRequest(request, baselinePhotoId) {
    const commandId = request.id + `-attempt${request.attempts + 1}`;
    
    try {
      console.log(`📤 Sending command ${commandId}: ${request.servoCommand}`);

      // 1. Kirim perintah dengan timestamp unik
      await db.ref("checkCameraMoveCommand").set({
        commandId: commandId,
        moveServo: request.servoCommand,
        status: 1,
        timestamp: Date.now(),
        purpose: request.purpose
      });

      // 2. Tunggu ESP32 selesai dengan multiple strategies
      const commandSuccess = await this.waitForESP32WithFallback(commandId);
      
      if (!commandSuccess) {
        throw new Error(`ESP32 failed to complete command ${commandId}`);
      }

      // 3. Tunggu foto dengan strategi bertingkat
      const photo = await this.getPhotoWithMultipleStrategies(baselinePhotoId, commandId);

      // 4. Bersihkan command
      await this.cleanupCommand();

      return photo;

    } catch (error) {
      console.error(`❌ Execute request failed for ${commandId}:`, error.message);
      
      // Clean up command on error
      try {
        await this.cleanupCommand();
      } catch (cleanupError) {
        console.error(`🧹 Cleanup error for ${commandId}:`, cleanupError.message);
      }

      throw error;
    }
  }

  // BARU: Tunggu ESP32 dengan fallback strategies
  async waitForESP32WithFallback(commandId) {
    const COMMAND_TIMEOUT = 45000; // Increased to 45 seconds
    const CHECK_INTERVAL = 1000;
    const startTime = Date.now();
    
    console.log(`⏳ Waiting for ESP32 to complete command ${commandId}...`);
    
    while (true) {
      const now = Date.now();
      const elapsed = now - startTime;
      
      // Check timeout
      if (elapsed > COMMAND_TIMEOUT) {
        console.log(`⚠️ ESP32 timeout reached, trying fallback strategies...`);
        
        // Fallback Strategy 1: Check if ESP32 is actually done but forgot to update status
        const fallbackSuccess = await this.checkIfESP32ActuallyDone(commandId);
        if (fallbackSuccess) {
          console.log(`✅ ESP32 actually completed (fallback detection)`);
          return true;
        }
        
        // Fallback Strategy 2: Force assume success if this is not first attempt
        if (commandId.includes('attempt2') || commandId.includes('attempt3')) {
          console.log(`🚨 Assuming ESP32 success on retry attempt`);
          return true;
        }
        
        return false;
      }

      try {
        const snap = await db.ref("checkCameraMoveCommand").once("value");
        const commandData = snap.val();
        
        // Check if command data exists and matches
        if (!commandData) {
          console.log(`⚠️ Command data missing for ${commandId}`);
          await this.delay(CHECK_INTERVAL);
          continue;
        }
        
        if (commandData.commandId !== commandId) {
          console.log(`⚠️ Command ID mismatch: expected ${commandId}, got ${commandData.commandId}`);
          await this.delay(CHECK_INTERVAL);
          continue;
        }

        // Check if command completed
        if (commandData.status === 0) {
          console.log(`✅ ESP32 completed command ${commandId}`);
          return true;
        }
        
        // Show progress every 10 seconds
        if (elapsed % 10000 < 1000 && elapsed > 5000) {
          console.log(`⏳ ESP32 still processing ${commandId}... (${Math.round(elapsed/1000)}s elapsed)`);
        }

      } catch (error) {
        console.error(`Error checking command status:`, error.message);
      }

      await this.delay(CHECK_INTERVAL);
    }
  }

  // BARU: Check if ESP32 actually completed but didn't update status
  async checkIfESP32ActuallyDone(commandId) {
    try {
      console.log(`🔍 Checking if ESP32 actually completed ${commandId}...`);
      
      // Strategy 1: Check if camera_busy was set to false (indicates ESP32 finished)
      const cameraBusySnap = await db.ref("deviceStatus/camera_busy").once("value");
      const isCameraBusy = cameraBusySnap.val() === true || cameraBusySnap.val() === "true";
      
      if (!isCameraBusy) {
        console.log(`📸 camera_busy is false, ESP32 might be done`);
        return true;
      }
      
      // Strategy 2: Check if there's a new photo in the last 2 minutes
      const recentPhoto = await this.checkForRecentPhoto(2 * 60 * 1000); // 2 minutes
      if (recentPhoto) {
        console.log(`📸 Recent photo found, ESP32 probably completed`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.log(`Error in fallback check:`, error.message);
      return false;
    }
  }

  // BARU: Check for recent photo
  async checkForRecentPhoto(timeWindow) {
    try {
      const photo = await getLatestPhotoFromGCS('pakan-ikan123');
      if (!photo) return false;
      
      // Try to get photo timestamp
      let photoTime = null;
      if (photo.timeCreated) {
        photoTime = new Date(photo.timeCreated).getTime();
      } else if (photo.name && photo.name.match(/photo_(\d+)\.jpg/)) {
        photoTime = parseInt(photo.name.match(/photo_(\d+)\.jpg/)[1]);
      }
      
      if (photoTime) {
        const now = Date.now();
        const timeDiff = now - photoTime;
        return Math.abs(timeDiff) <= timeWindow; // Account for timezone differences
      }
      
      return false;
    } catch (error) {
      console.log(`Error checking recent photo:`, error.message);
      return false;
    }
  }

  // BARU: Get photo with multiple strategies
  async getPhotoWithMultipleStrategies(baselinePhotoId, commandId) {
    console.log(`📸 Getting photo with multiple strategies...`);
    
    // Strategy 1: Wait a bit and get latest photo
    console.log(`⏳ Strategy 1: Waiting 5 seconds for photo processing...`);
    await this.delay(5000);
    
    let photo = await getLatestPhotoFromGCS('pakan-ikan123');
    if (photo) {
      const photoId = photo.name || photo.fileName || photo.id || 'unknown';
      console.log(`📸 Strategy 1 success: ${photoId}`);
      return photo;
    }
    
    // Strategy 2: Wait longer and try again
    console.log(`⏳ Strategy 2: Waiting additional 10 seconds...`);
    await this.delay(10000);
    
    photo = await getLatestPhotoFromGCS('pakan-ikan123');
    if (photo) {
      const photoId = photo.name || photo.fileName || photo.id || 'unknown';
      console.log(`📸 Strategy 2 success: ${photoId}`);
      return photo;
    }
    
    // Strategy 3: Try direct GCS access
    console.log(`📸 Strategy 3: Direct GCS access...`);
    photo = await getLatestPhotoDirectFromGCS();
    if (photo) {
      const photoId = photo.name || photo.fileName || photo.id || 'unknown';
      console.log(`📸 Strategy 3 success: ${photoId}`);
      return photo;
    }
    
    throw new Error(`No photo available after all strategies for ${commandId}`);
  }

  // Clean up command in database
  async cleanupCommand() {
    try {
      await db.ref("checkCameraMoveCommand").set({
        commandId: null,
        moveServo: null,
        status: 0,
        timestamp: null,
        purpose: null
      });
    } catch (error) {
      console.error("❌ Failed to cleanup command:", error.message);
    }
  }

  // Track failures to prevent spam
  recordFailure(key) {
    const now = Date.now();
    if (!this.failedRequests.has(key)) {
      this.failedRequests.set(key, []);
    }
    
    const failures = this.failedRequests.get(key);
    failures.push(now);
    
    // Keep only failures from last 30 minutes
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    this.failedRequests.set(key, failures.filter(time => time > thirtyMinutesAgo));
  }

  // Get recent failure count
  getRecentFailures(key) {
    if (!this.failedRequests.has(key)) {
      return 0;
    }
    
    const now = Date.now();
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const recentFailures = this.failedRequests.get(key).filter(time => time > thirtyMinutesAgo);
    
    return recentFailures.length;
  }

  // Utility delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get queue status with more details
  getStatus() {
    const now = Date.now();
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentRequestId: this.currentRequestId,
      lastSuccessfulCommand: this.lastSuccessfulCommand,
      photoReservations: Object.fromEntries(this.photoReservations),
      queuedRequests: this.queue.map(req => ({
        id: req.id,
        servoCommand: req.servoCommand,
        purpose: req.purpose,
        attempts: req.attempts,
        maxAttempts: req.maxAttempts,
        age: Math.round((now - req.createdAt) / 1000),
        timestamp: req.timestamp
      })),
      recentFailures: Object.fromEntries(this.failedRequests)
    };
  }

  // Clear queue (emergency) - improved
  clearQueue(reason = "Manual clear") {
    const rejectedCount = this.queue.length;
    this.queue.forEach(req => {
      req.reject(new Error(`Queue cleared: ${reason}`));
    });
    this.queue = [];
    
    // Reset processing state
    this.processing = false;
    this.currentRequestId = null;
    
    // Clear photo reservations
    this.photoReservations.clear();
    
    console.log(`🧹 Queue cleared (${reason}). ${rejectedCount} requests rejected.`);
    return rejectedCount;
  }

  // Force complete current request (emergency) - improved
  async forceCompleteCurrentRequest(reason = "Force complete") {
    if (this.currentRequestId) {
      console.log(`🚨 Force completing request: ${this.currentRequestId} (${reason})`);
      
      // Clean up database
      await this.cleanupCommand();
      await this.forceResetESP32(reason);
      
      // Reset state
      this.processing = false;
      this.currentRequestId = null;
      
      // Continue processing queue after short delay
      setTimeout(() => {
        console.log("🔄 Resuming queue processing after force complete...");
        this.processQueue();
      }, 5000);
      
      return true;
    }
    return false;
  }

  // New: Restart stuck queue
  async restartQueue() {
    console.log("🔄 Restarting stuck queue...");
    
    const currentRequest = this.currentRequestId;
    const queueLength = this.queue.length;
    
    // Force complete current request
    await this.forceCompleteCurrentRequest("Queue restart");
    
    // Clear failed requests cache and photo reservations
    this.failedRequests.clear();
    this.photoReservations.clear();
    
    console.log(`✅ Queue restarted. Previous current: ${currentRequest}, Queue length: ${queueLength}`);
    
    return {
      previousCurrentRequest: currentRequest,
      queueLength: queueLength,
      restarted: true
    };
  }
}

// ============= HELPER FUNCTIONS OUTSIDE CLASS =============

// Direct GCS access without polling flag interference
async function getLatestPhotoDirectFromGCS() {
  try {
    const { bucket } = require("../config/storage");
    if (!bucket) {
      console.log(`📸 Bucket not found in config/storage, using fallback...`);
      return await getLatestPhotoWithTimeout();
    }

    const [files] = await bucket.getFiles({ prefix: 'photo_' });
    if (!files.length) {
      console.log(`📸 No photos found in GCS bucket`);
      return null;
    }

    // Urutkan berdasarkan timestamp pada nama file
    files.sort((a, b) => {
      const aTime = parseInt(a.name.match(/\d+/)?.[0] || "0");
      const bTime = parseInt(b.name.match(/\d+/)?.[0] || "0");
      return bTime - aTime;
    });

    const latestFile = files[0];
    const [buffer] = await latestFile.download();

    console.log(`📸 Direct GCS fetch successful: ${latestFile.name}`);
    return { buffer, fileName: latestFile.name };

  } catch (error) {
    console.log(`📸 Direct GCS access failed (${error.message}), using fallback...`);
    return await getLatestPhotoWithTimeout();
  }
}

// Fallback method with timeout to prevent infinite waiting
async function getLatestPhotoWithTimeout() {
  const PHOTO_FETCH_TIMEOUT = 10000; // Increased to 10 seconds
  
  try {
    console.log(`📸 Using fallback getLatestPhotoFromGCS with timeout...`);
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Photo fetch timeout')), PHOTO_FETCH_TIMEOUT)
    );
    
    const photoPromise = getLatestPhotoFromGCS('pakan-ikan123');
    
    const result = await Promise.race([photoPromise, timeoutPromise]);
    return result;
    
  } catch (error) {
    console.log(`⚠️ Fallback photo fetch failed: ${error.message}`);
    return null;
  }
}

// ============= SINGLETON INSTANCE =============
const cameraQueue = new CameraFeedingQueue();

// Auto-restart mechanism: Check for stuck queue every 3 minutes
setInterval(async () => {
  const status = cameraQueue.getStatus();
  
  // If processing for more than 5 minutes, restart
  if (status.processing && status.currentRequestId) {
    const currentRequest = status.queuedRequests.find(r => r.id === status.currentRequestId);
    if (currentRequest && currentRequest.age > 300) { // 5 minutes
      console.log("🚨 Detected stuck queue, auto-restarting...");
      await cameraQueue.restartQueue();
    }
  }
  
  // Also check if ESP32 seems completely stuck (no successful commands in 10 minutes)
  if (status.lastSuccessfulCommand && Date.now() - status.lastSuccessfulCommand > 10 * 60 * 1000) {
    console.log("🚨 ESP32 seems stuck (no success in 10 minutes), forcing reset...");
    await cameraQueue.forceResetESP32("Long time no success");
  }
}, 3 * 60 * 1000); // Check every 3 minutes

// ============= PUBLIC API =============
async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
  console.log(`📨 New camera request: ${servoCommand}, purpose: ${purpose} at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);
  return await cameraQueue.addRequest(servoCommand, purpose);
}

// Admin functions
function getQueueStatus() {
  return cameraQueue.getStatus();
}

function clearQueue(reason) {
  return cameraQueue.clearQueue(reason);
}

function forceCompleteCurrentRequest(reason) {
  return cameraQueue.forceCompleteCurrentRequest(reason);
}

function restartQueue() {
  return cameraQueue.restartQueue();
}

function forceResetESP32(reason) {
  return cameraQueue.forceResetESP32(reason);
}

// ============= EXPORTS =============
module.exports = { 
  triggerCameraAndWait,
  getQueueStatus,
  clearQueue,
  forceCompleteCurrentRequest,
  restartQueue,
  forceResetESP32
};
//v1
// const { db } = require("../config/firebase");
// const { getLatestPhotoFromGCS } = require("./uploadFishFood");

// // ============= QUEUE SYSTEM =============
// class CameraFeedingQueue {
//   constructor() {
//     this.queue = [];
//     this.processing = false;
//     this.currentRequestId = null;
//     this.failedRequests = new Map(); // Track failed requests to prevent infinite retry
//   }

//   // Tambah request ke antrian
//   async addRequest(servoCommand, purpose = "makanan") {
//     return new Promise((resolve, reject) => {
//       const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

//       const request = {
//         id: requestId,
//         servoCommand,
//         purpose,
//         resolve,
//         reject,
//         timestamp: Date.now(),
//         attempts: 0,
//         maxAttempts: 3,
//         createdAt: Date.now()
//       };

//       this.queue.push(request);
//       console.log(`Request ${requestId} ditambahkan ke antrian. Queue length: ${this.queue.length}`);

//       // Mulai pemrosesan jika belum jalan
//       this.processQueue();
//     });
//   }

//   // Proses antrian satu per satu dengan timeout protection
//   async processQueue() {
//     if (this.processing || this.queue.length === 0) {
//       return;
//     }

//     this.processing = true;
    
//     while (this.queue.length > 0) {
//       const request = this.queue.shift();
//       this.currentRequestId = request.id;
      
//       console.log(`Memproses request ${request.id} - Servo: ${request.servoCommand} (attempt ${request.attempts + 1}/${request.maxAttempts})`);
      
//       try {
//         // Check if request is too old (older than 10 minutes)
//         const requestAge = Date.now() - request.createdAt;
//         if (requestAge > 10 * 60 * 1000) {
//           throw new Error(`Request expired: ${Math.round(requestAge / 60000)} minutes old`);
//         }

//         // Check if this request has failed too many times before
//         const failureKey = `${request.servoCommand}-${request.purpose}`;
//         const recentFailures = this.getRecentFailures(failureKey);
//         if (recentFailures >= 5) {
//           throw new Error(`Too many recent failures for command ${request.servoCommand}. Skipping.`);
//         }

//         // Cek apakah ESP32 sedang sibuk
//         const busyCheck = await this.checkESP32Status();
//         if (busyCheck.isBusy) {
//           throw new Error(`ESP32 sedang sibuk: ${busyCheck.reason}`);
//         }

//         // Eksekusi request dengan timeout
//         const result = await this.executeRequestWithTimeout(request);
//         request.resolve(result);
        
//         console.log(`✅ Request ${request.id} berhasil diproses`);
        
//       } catch (error) {
//         console.error(`❌ Request ${request.id} gagal:`, error.message);
        
//         // Increment attempt counter
//         request.attempts++;
        
//         // Check if we should retry
//         if (request.attempts < request.maxAttempts && 
//             !error.message.includes('expired') && 
//             !error.message.includes('Too many recent failures')) {
          
//           console.log(`🔄 Retrying request ${request.id} (${request.attempts}/${request.maxAttempts})`);
          
//           // Add back to front of queue for retry
//           this.queue.unshift(request);
            
//           // Wait before retry
//           await this.delay(3000);
//           continue;
//         }
        
//         // Request failed permanently
//         this.recordFailure(`${request.servoCommand}-${request.purpose}`);
//         request.reject(error);
//       } 
      
//       // Reset current request
//       this.currentRequestId = null;
      
//       // Delay antar request untuk mencegah overload
//       await this.delay(2000);
//     }
    
//     this.processing = false;
//     console.log("✅ Semua request dalam antrian selesai diproses");
//   }

//   // Execute request with overall timeout
//   async executeRequestWithTimeout(request) {
//     const TOTAL_TIMEOUT = 120000; // 2 minutes total timeout per request
    
//     return Promise.race([
//       this.executeRequest(request),
//       new Promise((_, reject) => 
//         setTimeout(() => reject(new Error(`Request ${request.id} timeout after ${TOTAL_TIMEOUT}ms`)), TOTAL_TIMEOUT)
//       )
//     ]);
//   }

//   // Cek status ESP32 sebelum kirim command
//   async checkESP32Status() {
//     try {
//       // Cek apakah sedang memproses
//       const statusSnap = await db.ref("deviceStatus/camera_busy").once("value");
//       const isCameraBusy = statusSnap.val() === true || statusSnap.val() === "true";
      
//       if (isCameraBusy) {
//         return { isBusy: true, reason: "Camera sedang digunakan" };
//       }

//       // Cek apakah ada command yang belum diproses
//       const commandSnap = await db.ref("checkCameraMoveCommand/status").once("value");
//       const commandStatus = commandSnap.val();
      
//       if (commandStatus === 1) {
//         return { isBusy: true, reason: "Masih ada command yang belum selesai" };
//       }

//       return { isBusy: false };
//     } catch (error) {
//       return { isBusy: true, reason: `Error checking status: ${error.message}` };
//     }
//   }

//   // Eksekusi request individual - SIMPLIFIED WITH BETTER ERROR HANDLING
//   async executeRequest(request) {
//     const commandId = request.id + `-attempt${request.attempts + 1}`;
    
//     try {
//       console.log(`📤 Sending command ${commandId}: ${request.servoCommand}`);

//       // 1. Kirim perintah dengan timestamp unik
//       await db.ref("checkCameraMoveCommand").set({
//         commandId: commandId,
//         moveServo: request.servoCommand,
//         status: 1,
//         timestamp: Date.now(),
//         purpose: request.purpose
//       });

//       // 2. Tunggu sampai selesai dengan monitoring yang lebih strict
//       const result = await this.waitForCompletionWithStrictTimeout(commandId);

//       // 3. Bersihkan command
//       await this.cleanupCommand();

//       return result;

//     } catch (error) {
//       console.error(`❌ Execute request failed for ${commandId}:`, error.message);
      
//       // Clean up command on error
//       try {
//         await this.cleanupCommand();
//       } catch (cleanupError) {
//         console.error(`🧹 Cleanup error for ${commandId}:`, cleanupError.message);
//       }

//       throw error;
//     }
//   }

//   // Wait for completion with strict timeout and better photo checking
//   async waitForCompletionWithStrictTimeout(commandId) {
//     const COMMAND_TIMEOUT = 30000; // 30 seconds for ESP32 to complete
//     const PHOTO_TIMEOUT = 60000;   // 60 seconds to find photo
//     const CHECK_INTERVAL = 1000;   // Check every 1 second
    
//     let commandStartTime = Date.now();
//     let commandCompleted = false;
//     let photoCheckStartTime = null;
//     let lastPhotoCheck = null;
    
//     console.log(`⏳ Waiting for command ${commandId} completion...`);

//     while (true) {
//       const now = Date.now();
      
//       try {
//         // Phase 1: Wait for ESP32 to complete command
//         if (!commandCompleted) {
//           // Check command timeout
//           if (now - commandStartTime > COMMAND_TIMEOUT) {
//             throw new Error(`Command ${commandId} timeout - ESP32 tidak merespons dalam ${COMMAND_TIMEOUT}ms`);
//           }

//           const snap = await db.ref("checkCameraMoveCommand").once("value");
//           const commandData = snap.val();
          
//           if (!commandData || commandData.commandId !== commandId) {
//             throw new Error(`Command ${commandId} data corrupted or not found`);
//           }

//           // Check if command completed
//           if (commandData.status === 0) {
//             console.log(`✅ Command ${commandId} completed by ESP32`);
//             commandCompleted = true;
//             photoCheckStartTime = now;
//           }
//         }

//         // Phase 2: Wait for photo after command completion
//         if (commandCompleted) {
//           // Check photo timeout
//           const photoWaitTime = now - photoCheckStartTime;
//           if (photoWaitTime > PHOTO_TIMEOUT) {
//             // Before failing, try one more time with any recent photo
//             console.log(`⚠️ Photo timeout reached, trying fallback strategy...`);
//             const fallbackPhoto = await this.findRecentPhoto(commandStartTime);
//             if (fallbackPhoto) {
//               return fallbackPhoto;
//             }
//             throw new Error(`Photo not found for ${commandId} after ${PHOTO_TIMEOUT}ms`);
//           }

//           console.log(`📸 Checking for photo (${Math.round(photoWaitTime/1000)}s since completion)...`);
          
//           const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
          
//           if (latestPhoto) {
//             // Debug: Log photo object structure
//             console.log(`📸 Photo object:`, {
//               name: latestPhoto.name,
//               fileName: latestPhoto.fileName,
//               id: latestPhoto.id,
//               timeCreated: latestPhoto.timeCreated,
//               updated: latestPhoto.updated,
//               keys: Object.keys(latestPhoto)
//             });
            
//             // Get photo identifier - handle different property names
//             const photoId = latestPhoto.name || latestPhoto.fileName || latestPhoto.id || 'unknown';
//             const lastPhotoId = lastPhotoCheck ? (lastPhotoCheck.name || lastPhotoCheck.fileName || lastPhotoCheck.id) : null;
            
//             // Strategy 1: Check if this is a new photo since we started
//             if (!lastPhotoCheck || photoId !== lastPhotoId) {
//               console.log(`📸 New photo detected: ${photoId}`);
              
//               // Strategy 2: Validate photo timestamp with timezone tolerance
//               const isValidPhoto = this.validatePhotoTimestamp(latestPhoto, commandStartTime, now);
//               if (isValidPhoto.valid) {
//                 console.log(`📸 Valid photo found for ${commandId}: ${photoId} (${isValidPhoto.reason})`);
//                 return latestPhoto;
//               } else {
//                 console.log(`📸 Photo rejected: ${isValidPhoto.reason}`);
//               }
//             } else {
//               console.log(`📸 Same photo as before: ${photoId}, waiting for new one...`);
//             }
            
//             lastPhotoCheck = latestPhoto;
//           }
//         }

//       } catch (error) {
//         console.error(`❌ Error monitoring ${commandId}:`, error.message);
//         throw error;
//       }

//       await this.delay(CHECK_INTERVAL);
//     }
//   }

//   // Smart photo validation with timezone handling
//   validatePhotoTimestamp(photo, commandStartTime, currentTime) {
//     try {
//       // Try multiple timestamp properties and formats
//       let photoTime = null;
//       let timestampSource = '';
      
//       // Try different timestamp properties
//       if (photo.timeCreated) {
//         photoTime = new Date(photo.timeCreated);
//         timestampSource = 'timeCreated';
//       } else if (photo.updated) {
//         photoTime = new Date(photo.updated);
//         timestampSource = 'updated';
//       } else if (photo.created) {
//         photoTime = new Date(photo.created);
//         timestampSource = 'created';
//       } else if (photo.lastModified) {
//         photoTime = new Date(photo.lastModified);
//         timestampSource = 'lastModified';
//       } else {
//         // Fallback: try to extract timestamp from filename
//         const photoId = photo.name || photo.fileName || photo.id || '';
//         const timestampMatch = photoId.match(/photo_(\d+)\.jpg/);
//         if (timestampMatch) {
//           photoTime = new Date(parseInt(timestampMatch[1]));
//           timestampSource = 'filename';
//         }
//       }
      
//       // Handle invalid timestamps
//       if (!photoTime || isNaN(photoTime.getTime())) {
//         console.log(`📸 Available photo properties:`, Object.keys(photo));
//         return { valid: false, reason: `Invalid photo timestamp from ${timestampSource}` };
//       }
      
//       const photoTimestamp = photoTime.getTime();
//       const timeDiffFromCommand = photoTimestamp - commandStartTime;
//       const timeDiffFromNow = currentTime - photoTimestamp;
      
//       console.log(`📸 Photo validation (${timestampSource}):
//         - Photo time: ${photoTime.toISOString()}
//         - Command start: ${new Date(commandStartTime).toISOString()}  
//         - Current time: ${new Date(currentTime).toISOString()}
//         - Diff from command: ${Math.round(timeDiffFromCommand/1000)}s
//         - Diff from now: ${Math.round(timeDiffFromNow/1000)}s`);
      
//       // Strategy 1: Photo taken after command started (ideal case)
//       if (timeDiffFromCommand >= -5000 && timeDiffFromCommand <= 120000) { // -5s to +2min from command
//         return { valid: true, reason: `photo taken ${Math.round(timeDiffFromCommand/1000)}s after command (${timestampSource})` };
//       }
      
//       // Strategy 2: Photo is very recent (handle timezone issues)
//       if (Math.abs(timeDiffFromNow) <= 300000) { // Within 5 minutes of current time (either direction)
//         return { valid: true, reason: `recent photo ${Math.round(timeDiffFromNow/1000)}s from now (${timestampSource})` };
//       }
      
//       // Strategy 3: For timezone issues, check if photo could be from this session
//       // If server thinks photo is from future but within reasonable range, accept it
//       if (timeDiffFromNow < 0 && Math.abs(timeDiffFromNow) <= 8 * 60 * 60 * 1000) { // Up to 8 hours in "future"
//         return { valid: true, reason: `timezone-adjusted photo ${Math.round(timeDiffFromNow/3600000)}h ahead (${timestampSource})` };
//       }
      
//       return { 
//         valid: false, 
//         reason: `photo too old/distant: ${Math.round(timeDiffFromCommand/1000)}s from command, ${Math.round(timeDiffFromNow/1000)}s from now (${timestampSource})` 
//       };
      
//     } catch (error) {
//       console.error("Error validating photo timestamp:", error);
//       return { valid: false, reason: `validation error: ${error.message}` };
//     }
//   }

//   // Fallback: Find any photo that might be from this command session
//   async findRecentPhoto(commandStartTime) {
//     try {
//       console.log(`🔍 Searching for any recent photo since command started...`);
//       const photo = await getLatestPhotoFromGCS('pakan-ikan123');
      
//       if (photo) {
//         const photoId = photo.name || photo.fileName || photo.id || 'unknown';
//         console.log(`🔍 Found photo in fallback: ${photoId}`);
        
//         const validation = this.validatePhotoTimestamp(photo, commandStartTime, Date.now());
//         if (validation.valid) {
//           console.log(`📸 Fallback photo accepted: ${photoId} (${validation.reason})`);
//           return photo;
//         } else {
//           console.log(`📸 Fallback photo rejected: ${validation.reason}`);
//         }
//       } else {
//         console.log(`🔍 No photo found in fallback search`);
//       }
      
//       return null;
//     } catch (error) {
//       console.error("Error in fallback photo search:", error);
//       return null;
//     }
//   }

//   // Clean up command in database
//   async cleanupCommand() {
//     try {
//       await db.ref("checkCameraMoveCommand").set({
//         commandId: null,
//         moveServo: null,
//         status: 0,
//         timestamp: null,
//         purpose: null
//       });
//     } catch (error) {
//       console.error("❌ Failed to cleanup command:", error.message);
//     }
//   }

//   // Track failures to prevent spam
//   recordFailure(key) {
//     const now = Date.now();
//     if (!this.failedRequests.has(key)) {
//       this.failedRequests.set(key, []);
//     }
    
//     const failures = this.failedRequests.get(key);
//     failures.push(now);
    
//     // Keep only failures from last 30 minutes
//     const thirtyMinutesAgo = now - 30 * 60 * 1000;
//     this.failedRequests.set(key, failures.filter(time => time > thirtyMinutesAgo));
//   }

//   // Get recent failure count
//   getRecentFailures(key) {
//     if (!this.failedRequests.has(key)) {
//       return 0;
//     }
    
//     const now = Date.now();
//     const thirtyMinutesAgo = now - 30 * 60 * 1000;
//     const recentFailures = this.failedRequests.get(key).filter(time => time > thirtyMinutesAgo);
    
//     return recentFailures.length;
//   }

//   // Utility delay function
//   delay(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms));
//   }

//   // Get queue status with more details
//   getStatus() {
//     const now = Date.now();
//     return {
//       queueLength: this.queue.length,
//       processing: this.processing,
//       currentRequestId: this.currentRequestId,
//       queuedRequests: this.queue.map(req => ({
//         id: req.id,
//         servoCommand: req.servoCommand,
//         purpose: req.purpose,
//         attempts: req.attempts,
//         maxAttempts: req.maxAttempts,
//         age: Math.round((now - req.createdAt) / 1000),
//         timestamp: req.timestamp
//       })),
//       recentFailures: Object.fromEntries(this.failedRequests)
//     };
//   }

//   // Clear queue (emergency) - improved
//   clearQueue(reason = "Manual clear") {
//     const rejectedCount = this.queue.length;
//     this.queue.forEach(req => {
//       req.reject(new Error(`Queue cleared: ${reason}`));
//     });
//     this.queue = [];
    
//     // Reset processing state
//     this.processing = false;
//     this.currentRequestId = null;
    
//     console.log(`🧹 Queue cleared (${reason}). ${rejectedCount} requests rejected.`);
//     return rejectedCount;
//   }

//   // Force complete current request (emergency) - improved
//   async forceCompleteCurrentRequest(reason = "Force complete") {
//     if (this.currentRequestId) {
//       console.log(`🚨 Force completing request: ${this.currentRequestId} (${reason})`);
      
//       // Clean up database
//       await this.cleanupCommand();
      
//       // Reset state
//       this.processing = false;
//       this.currentRequestId = null;
      
//       // Continue processing queue after short delay
//       setTimeout(() => {
//         console.log("🔄 Resuming queue processing after force complete...");
//         this.processQueue();
//       }, 2000);
      
//       return true;
//     }
//     return false;
//   }

//   // New: Restart stuck queue
//   async restartQueue() {
//     console.log("🔄 Restarting stuck queue...");
    
//     const currentRequest = this.currentRequestId;
//     const queueLength = this.queue.length;
    
//     // Force complete current request
//     await this.forceCompleteCurrentRequest("Queue restart");
    
//     // Clear failed requests cache
//     this.failedRequests.clear();
    
//     console.log(`✅ Queue restarted. Previous current: ${currentRequest}, Queue length: ${queueLength}`);
    
//     return {
//       previousCurrentRequest: currentRequest,
//       queueLength: queueLength,
//       restarted: true
//     };
//   }
// }

// // ============= SINGLETON INSTANCE =============
// const cameraQueue = new CameraFeedingQueue();

// // Auto-restart mechanism: Check for stuck queue every 5 minutes
// setInterval(async () => {
//   const status = cameraQueue.getStatus();
  
//   // If processing for more than 5 minutes, restart
//   if (status.processing && status.currentRequestId) {
//     const currentRequest = status.queuedRequests.find(r => r.id === status.currentRequestId);
//     if (currentRequest && currentRequest.age > 300) { // 5 minutes
//       console.log("🚨 Detected stuck queue, auto-restarting...");
//       await cameraQueue.restartQueue();
//     }
//   }
// }, 5 * 60 * 1000); // Check every 5 minutes

// // ============= PUBLIC API =============
// async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
//   console.log(`📨 New camera request: ${servoCommand}, purpose: ${purpose}`);
//   return await cameraQueue.addRequest(servoCommand, purpose);
// }

// // Admin functions
// function getQueueStatus() {
//   return cameraQueue.getStatus();
// }

// function clearQueue(reason) {
//   return cameraQueue.clearQueue(reason);
// }

// function forceCompleteCurrentRequest(reason) {
//   return cameraQueue.forceCompleteCurrentRequest(reason);
// }

// function restartQueue() {
//   return cameraQueue.restartQueue();
// }

// // ============= EXPORTS =============
// module.exports = { 
//   triggerCameraAndWait,
//   getQueueStatus,
//   clearQueue,
//   forceCompleteCurrentRequest,
//   restartQueue
// };