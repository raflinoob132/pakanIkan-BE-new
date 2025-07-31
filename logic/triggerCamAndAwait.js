const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("./uploadFishFood");

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

        // Cek apakah ESP32 sedang sibuk
        const busyCheck = await this.checkESP32Status();
        if (busyCheck.isBusy) {
          throw new Error(`ESP32 sedang sibuk: ${busyCheck.reason}`);
        }

        // Eksekusi request dengan timeout
        const result = await this.executeRequestWithTimeout(request);
        request.resolve(result);
        
        console.log(`✅ Request ${request.id} berhasil diproses`);
        
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
            
          // Wait before retry
          await this.delay(10000);
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

  // Execute request with overall timeout
  async executeRequestWithTimeout(request) {
    const TOTAL_TIMEOUT = 120000; // 2 minutes total timeout per request
    
    return Promise.race([
      this.executeRequest(request),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Request ${request.id} timeout after ${TOTAL_TIMEOUT}ms`)), TOTAL_TIMEOUT)
      )
    ]);
  }

  // Cek status ESP32 sebelum kirim command
  async checkESP32Status() {
    try {
      // Cek apakah sedang memproses
      const statusSnap = await db.ref("deviceStatus/camera_busy").once("value");
      const isCameraBusy = statusSnap.val() === true || statusSnap.val() === "true";
      
      if (isCameraBusy) {
        return { isBusy: true, reason: "Camera sedang digunakan" };
      }

      // Cek apakah ada command yang belum diproses
      const commandSnap = await db.ref("checkCameraMoveCommand/status").once("value");
      const commandStatus = commandSnap.val();
      
      if (commandStatus === 1) {
        return { isBusy: true, reason: "Masih ada command yang belum selesai" };
      }

      return { isBusy: false };
    } catch (error) {
      return { isBusy: true, reason: `Error checking status: ${error.message}` };
    }
  }

  // SIMPLIFIED: executeRequest tanpa baseline ribet
  async executeRequest(request) {
    const commandId = request.id + `-${Date.now()}`; // Always unique per execution
    
    try {
      console.log(`📤 Sending command ${commandId}: ${request.servoCommand} (attempt ${request.attempts + 1})`);

      // 1. Kirim perintah
      await db.ref("checkCameraMoveCommand").set({
        commandId: commandId,
        moveServo: request.servoCommand,
        status: 1,
        timestamp: Date.now(),
        purpose: request.purpose
      });

      // 2. Tunggu ESP32 selesai
      await this.waitForESP32CompletionOnly(commandId);

      // 3. Tunggu sebentar buat upload
      console.log(`⏳ Waiting 5 seconds for photo upload...`);
      await this.delay(5000); // Naikin jadi 5 detik

      // 4. Ambil foto terbaru dengan debugging
      console.log(`📸 Fetching latest photo from bucket...`);
      const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan1234', true);
      
      if (!latestPhoto) {
        throw new Error(`No photo available after command ${commandId}`);
      }

      const photoTimestamp = latestPhoto.name ? latestPhoto.name.match(/\d+/)?.[0] : null;
      const photoTime = photoTimestamp ? new Date(parseInt(photoTimestamp)) : null;
      
      console.log(`📸 Got photo: ${latestPhoto.name || latestPhoto.fileName}`);
      console.log(`📸 Photo timestamp: ${photoTime ? photoTime.toISOString() : 'unknown'}`);
      console.log(`📸 Command started at: ${new Date(request.timestamp).toISOString()}`);
      
      // Check if photo is newer than command
      if (photoTimestamp && parseInt(photoTimestamp) < request.timestamp) {
        console.log(`⚠️ WARNING: Photo seems older than command! Possible issue.`);
      }
      
      // 5. Upload foto ke Telegram (jangan lupa!)
      try {
        const { sendTelegramImage } = require('../telegram/telegramUtils');
        await sendTelegramImage(latestPhoto.buffer, `Camera command executed: ${request.servoCommand}`);
        console.log(`📱 Photo sent to Telegram successfully`);
      } catch (telegramError) {
        console.error(`📱 Failed to send to Telegram:`, telegramError.message);
        // Don't fail the whole request just because Telegram failed
      }
      
      // 6. Bersihkan command
      await this.cleanupCommand();

      return latestPhoto;

    } catch (error) {
      console.error(`❌ Execute request failed for ${commandId}:`, error.message);
      
      // Clean up
      try {
        await this.cleanupCommand();
      } catch (cleanupError) {
        console.error(`🧹 Cleanup error:`, cleanupError.message);
      }

      throw error;
    }
  }

  // Tunggu ESP32 selesai
  async waitForESP32CompletionOnly(commandId) {
    const COMMAND_TIMEOUT = 30000; // 30 seconds
    const CHECK_INTERVAL = 1000;   // Check every 1 second
    const startTime = Date.now();
    
    console.log(`⏳ Waiting for ESP32 to complete command ${commandId}...`);
    
    while (true) {
      const now = Date.now();
      
      // Check timeout
      if (now - startTime > COMMAND_TIMEOUT) {
        throw new Error(`Command ${commandId} timeout - ESP32 tidak merespons dalam ${COMMAND_TIMEOUT}ms`);
      }

      const snap = await db.ref("checkCameraMoveCommand").once("value");
      const commandData = snap.val();
      
      if (!commandData || commandData.commandId !== commandId) {
        throw new Error(`Command ${commandId} data corrupted or not found`);
      }

      // Check if command completed
      if (commandData.status === 0) {
        console.log(`✅ ESP32 completed command ${commandId}`);
        return;
      }
      
      // Show progress every 5 seconds
      const elapsed = Math.round((now - startTime) / 1000);
      if (elapsed % 5 === 0 && elapsed > 0) {
        console.log(`⏳ ESP32 still processing ${commandId}... (${elapsed}s elapsed)`);
      }

      await this.delay(CHECK_INTERVAL);
    }
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

  // Get queue status
  getStatus() {
    const now = Date.now();
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentRequestId: this.currentRequestId,
      queuedRequests: this.queue.map(req => ({
        id: req.id,
        servoCommand: req.servoCommand,
        purpose: req.purpose,
        attempts: req.attempts,
        maxAttempts: req.maxAttempts,
        age: Math.round((now - req.createdAt) / 1000)
      })),
      recentFailures: Object.fromEntries(this.failedRequests)
    };
  }

  // Clear queue (emergency)
  clearQueue(reason = "Manual clear") {
    const rejectedCount = this.queue.length;
    this.queue.forEach(req => {
      req.reject(new Error(`Queue cleared: ${reason}`));
    });
    this.queue = [];
    
    // Reset processing state
    this.processing = false;
    this.currentRequestId = null;
    
    console.log(`🧹 Queue cleared (${reason}). ${rejectedCount} requests rejected.`);
    return rejectedCount;
  }

  // Force complete current request (emergency)
  async forceCompleteCurrentRequest(reason = "Force complete") {
    if (this.currentRequestId) {
      console.log(`🚨 Force completing request: ${this.currentRequestId} (${reason})`);
      
      // Clean up database
      await this.cleanupCommand();
      
      // Reset state
      this.processing = false;
      this.currentRequestId = null;
      
      // Continue processing queue after short delay
      setTimeout(() => {
        console.log("🔄 Resuming queue processing after force complete...");
        this.processQueue();
      }, 2000);
      
      return true;
    }
    return false;
  }

  // Restart stuck queue
  async restartQueue() {
    console.log("🔄 Restarting stuck queue...");
    
    const currentRequest = this.currentRequestId;
    const queueLength = this.queue.length;
    
    // Force complete current request
    await this.forceCompleteCurrentRequest("Queue restart");
    
    // Clear failed requests cache
    this.failedRequests.clear();
    
    console.log(`✅ Queue restarted. Previous current: ${currentRequest}, Queue length: ${queueLength}`);
    
    return {
      previousCurrentRequest: currentRequest,
      queueLength: queueLength,
      restarted: true
    };
  }
}

// ============= SINGLETON INSTANCE =============
const cameraQueue = new CameraFeedingQueue();

// Auto-restart mechanism: Check for stuck queue every 5 minutes
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
}, 5 * 60 * 1000); // Check every 5 minutes

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

// ============= EXPORTS =============
module.exports = { 
  triggerCameraAndWait,
  getQueueStatus,
  clearQueue,
  forceCompleteCurrentRequest,
  restartQueue
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