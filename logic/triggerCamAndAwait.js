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

// ============= SIMPLE & ROBUST QUEUE SYSTEM =============
class CameraFeedingQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentRequestId = null;
    this.failedRequests = new Map();
    this.lastPhotoPerKolam = new Map(); // Track last successful photo per kolam
    this.lastRequestTime = new Map(); // Track last request time per kolam
  }

  // Tambah request ke antrian
  async addRequest(servoCommand, purpose = "makanan") {
    return new Promise((resolve, reject) => {
      const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      
      // Determine kolam from servo command
      const kolam = this.determineKolam(servoCommand);

      const request = {
        id: requestId,
        servoCommand,
        purpose,
        kolam,
        resolve,
        reject,
        timestamp: Date.now(),
        attempts: 0,
        maxAttempts: 3,
        createdAt: Date.now()
      };

      this.queue.push(request);
      console.log(`📝 Request ${requestId} untuk ${kolam} ditambahkan ke antrian. Queue: ${this.queue.length}`);

      // Start processing if not already running
      this.processQueue();
    });
  }

  // Determine kolam from servo command
  determineKolam(servoCommand) {
    if (servoCommand.includes("170,140")) return "kolam1";
    if (servoCommand.includes("35,140")) return "kolam2";
    return "unknown";
  }

  // Process queue with simple but effective logic
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    console.log(`🎯 Starting queue processing. Items: ${this.queue.length}`);
    
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      this.currentRequestId = request.id;
      
      console.log(`\n🔄 Processing ${request.kolam} request ${request.id} (${request.servoCommand}) - Attempt ${request.attempts + 1}/${request.maxAttempts}`);
      
      try {
        // 1. Check request age
        const requestAge = Date.now() - request.createdAt;
        if (requestAge > 20 * 60 * 1000) { // 20 minutes
          throw new Error(`Request expired: ${Math.round(requestAge / 60000)} minutes old`);
        }

        // 2. Check minimum interval between requests for same kolam
        const lastTime = this.lastRequestTime.get(request.kolam) || 0;
        const timeSinceLastRequest = Date.now() - lastTime;
        const minInterval = 60000; // 1 minute minimum between same kolam requests
        
        if (timeSinceLastRequest < minInterval) {
          const waitTime = minInterval - timeSinceLastRequest;
          console.log(`⏱️ Waiting ${Math.round(waitTime/1000)}s for ${request.kolam} interval`);
          await this.delay(waitTime);
        }

        // 3. Check ESP32 availability
        const canProceed = await this.ensureESP32Ready();
        if (!canProceed.ready) {
          throw new Error(`ESP32 not ready: ${canProceed.reason}`);
        }

        // 4. Get baseline photo for this kolam
        const baseline = await this.getBaselineForKolam(request.kolam);
        console.log(`📸 Baseline for ${request.kolam}: ${baseline}`);

        // 5. Execute the request
        const result = await this.executeRequest(request, baseline);
        
        // 6. Update tracking data
        this.lastRequestTime.set(request.kolam, Date.now());
        if (result) {
          const photoId = result.name || result.fileName || result.id;
          if (photoId) {
            this.lastPhotoPerKolam.set(request.kolam, photoId);
          }
        }

        request.resolve(result);
        console.log(`✅ ${request.kolam} request ${request.id} completed successfully`);
        
      } catch (error) {
        console.error(`❌ ${request.kolam} request ${request.id} failed:`, error.message);
        
        request.attempts++;
        
        // Retry logic
        if (request.attempts < request.maxAttempts && 
            !error.message.includes('expired')) {
          
          console.log(`🔄 Retrying ${request.kolam} request ${request.id} (${request.attempts}/${request.maxAttempts})`);
          this.queue.unshift(request); // Put back at front
          
          // Wait before retry
          await this.delay(30000); // 30 seconds retry delay
          continue;
        }
        
        // Request failed permanently
        this.recordFailure(request.kolam);
        request.reject(error);
      } 
      
      this.currentRequestId = null;
      
      // Delay between requests
      await this.delay(10000); // 10 seconds between any requests
    }
    
    this.processing = false;
    console.log("✅ Queue processing completed\n");
  }

  // Get baseline photo for specific kolam
  async getBaselineForKolam(kolam) {
    try {
      // Strategy 1: Use last successful photo from this kolam
      if (this.lastPhotoPerKolam.has(kolam)) {
        const lastPhoto = this.lastPhotoPerKolam.get(kolam);
        console.log(`📸 Using last successful photo for ${kolam}: ${lastPhoto}`);
        return lastPhoto;
      }

      // Strategy 2: Get current latest photo and claim it for this kolam
      const currentLatest = await this.getLatestPhotoSafely();
      if (currentLatest) {
        const photoId = currentLatest.name || currentLatest.fileName || currentLatest.id;
        console.log(`📸 Claiming current latest for ${kolam}: ${photoId}`);
        this.lastPhotoPerKolam.set(kolam, photoId);
        return photoId;
      }

      // Strategy 3: Use a safe fallback timestamp
      const fallbackId = `photo_${Date.now() - 300000}.jpg`; // 5 minutes ago
      console.log(`📸 Using fallback baseline for ${kolam}: ${fallbackId}`);
      return fallbackId;
      
    } catch (error) {
      console.error(`❌ Error getting baseline for ${kolam}:`, error);
      return `photo_${Date.now() - 300000}.jpg`; // Safe fallback
    }
  }

  // Safely get latest photo with timeout
  async getLatestPhotoSafely() {
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Photo fetch timeout')), 5000)
      );

      const photoPromise = this.getLatestPhotoDirectFromGCS();
      const result = await Promise.race([photoPromise, timeoutPromise]);
      
      return result;
    } catch (error) {
      console.log(`⚠️ Safe photo fetch failed: ${error.message}`);
      return null;
    }
  }

  // Direct GCS access
  async getLatestPhotoDirectFromGCS() {
    try {
      if (!bucket) {
        throw new Error("Bucket not available");
      }

      const [files] = await bucket.getFiles({ prefix: 'photo_' });
      if (!files.length) {
        return null;
      }

      // Sort by timestamp in filename
      files.sort((a, b) => {
        const aTime = parseInt(a.name.match(/\d+/)?.[0] || "0");
        const bTime = parseInt(b.name.match(/\d+/)?.[0] || "0");
        return bTime - aTime;
      });

      const latestFile = files[0];
      const [buffer] = await latestFile.download();

      return { 
        buffer, 
        fileName: latestFile.name, 
        name: latestFile.name,
        id: latestFile.name
      };

    } catch (error) {
      console.log(`📸 Direct GCS failed: ${error.message}`);
      // Fallback to original method
      return await getLatestPhotoFromGCS('pakan-ikan1234');
    }
  }

  // Ensure ESP32 is ready with force cleanup
  async ensureESP32Ready() {
    try {
      console.log(`🔍 Checking ESP32 status...`);
      
      // Check camera busy status
      const busySnap = await db.ref("deviceStatus/camera_busy").once("value");
      const busyTimestampSnap = await db.ref("deviceStatus/camera_busy_timestamp").once("value");
      
      const isBusy = busySnap.val() === true || busySnap.val() === "true";
      const lastBusyTime = busyTimestampSnap.val() || 0;
      const busyDuration = Date.now() - lastBusyTime;
      
      if (isBusy) {
        // Force clear if stuck for more than 2 minutes
        if (busyDuration > 120000) {
          console.log(`🚨 Camera stuck for ${Math.round(busyDuration/1000)}s, force clearing...`);
          await db.ref("deviceStatus/camera_busy").set(false);
          await db.ref("deviceStatus/camera_busy_timestamp").set(Date.now());
        } else {
          return { ready: false, reason: `Camera busy for ${Math.round(busyDuration/1000)}s` };
        }
      }

      // Check command status
      const commandSnap = await db.ref("checkCameraMoveCommand").once("value");
      const commandData = commandSnap.val();
      
      if (commandData && commandData.status === 1) {
        const commandAge = Date.now() - (commandData.timestamp || 0);
        
        // Force clear if stuck for more than 2 minutes
        if (commandAge > 120000) {
          console.log(`🚨 Command stuck for ${Math.round(commandAge/1000)}s, force clearing...`);
          await this.forceCleanupCommand();
        } else {
          return { ready: false, reason: `Command pending for ${Math.round(commandAge/1000)}s` };
        }
      }

      console.log(`✅ ESP32 ready for new request`);
      return { ready: true };
      
    } catch (error) {
      console.error(`❌ Error checking ESP32 status:`, error);
      return { ready: false, reason: `Status check error: ${error.message}` };
    }
  }

  // Execute single request with timeout
  async executeRequest(request, baselinePhotoId) {
    const commandId = request.id + `-attempt${request.attempts + 1}`;
    const timeout = 180000; // 3 minutes total timeout
    
    console.log(`🚀 Executing ${request.kolam} command ${commandId}`);
    
    try {
      // Set busy flags first
      await db.ref("deviceStatus/camera_busy").set(true);
      await db.ref("deviceStatus/camera_busy_timestamp").set(Date.now());

      const commandStartTime = Date.now();

      // Send command to ESP32
      await db.ref("checkCameraMoveCommand").set({
        commandId: commandId,
        moveServo: request.servoCommand,
        status: 1,
        timestamp: commandStartTime,
        purpose: request.purpose
      });

      console.log(`📤 Command sent to ESP32: ${commandId}`);

      // Wait for ESP32 to complete with timeout
      const result = await Promise.race([
        this.waitForESP32Completion(commandId, baselinePhotoId, commandStartTime),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Command ${commandId} total timeout after ${timeout}ms`)), timeout)
        )
      ]);

      // Success cleanup
      await this.cleanupAfterSuccess();
      return result;

    } catch (error) {
      console.error(`❌ Command ${commandId} failed:`, error.message);
      
      // Error cleanup
      await this.cleanupAfterError();
      throw error;
    }
  }

  // Wait for ESP32 to complete command and return new photo
  async waitForESP32Completion(commandId, baselinePhotoId, commandStartTime) {
    const ESP32_TIMEOUT = 60000; // 1 minute for ESP32 to complete
    const PHOTO_TIMEOUT = 90000;  // 1.5 minutes to find new photo
    const CHECK_INTERVAL = 2000;  // Check every 2 seconds
    
    let esp32Completed = false;
    let photoSearchStartTime = null;
    
    console.log(`⏳ Waiting for ESP32 to complete ${commandId}...`);
    console.log(`📸 Baseline photo: ${baselinePhotoId}`);

    while (true) {
      const now = Date.now();
      
      try {
        // Phase 1: Wait for ESP32 to complete
        if (!esp32Completed) {
          // Check ESP32 timeout
          if (now - commandStartTime > ESP32_TIMEOUT) {
            throw new Error(`ESP32 timeout for ${commandId} - no response in ${ESP32_TIMEOUT}ms`);
          }

          // Check command status in Firebase
          const commandSnap = await db.ref("checkCameraMoveCommand").once("value");
          const commandData = commandSnap.val();
          
          // Validate command still exists and matches
          if (!commandData || commandData.commandId !== commandId) {
            throw new Error(`Command ${commandId} not found or corrupted in Firebase`);
          }

          // Check if ESP32 completed (status = 0)
          if (commandData.status === 0) {
            console.log(`✅ ESP32 completed ${commandId}`);
            esp32Completed = true;
            photoSearchStartTime = now;
          } else {
            console.log(`⏳ ESP32 still processing ${commandId} (${Math.round((now - commandStartTime)/1000)}s)`);
          }
        }

        // Phase 2: Wait for new photo
        if (esp32Completed) {
          const photoSearchTime = now - photoSearchStartTime;
          
          // Check photo timeout
          if (photoSearchTime > PHOTO_TIMEOUT) {
            throw new Error(`No new photo found for ${commandId} after ${PHOTO_TIMEOUT}ms`);
          }

          console.log(`📸 Searching for new photo (${Math.round(photoSearchTime/1000)}s since ESP32 completion)...`);
          
          // Get latest photo
          const latestPhoto = await this.getLatestPhotoSafely();
          
          if (latestPhoto) {
            const currentPhotoId = latestPhoto.name || latestPhoto.fileName || latestPhoto.id;
            
            // Check if this is a NEW photo (different from baseline)
            if (currentPhotoId && currentPhotoId !== baselinePhotoId) {
              console.log(`📸 NEW photo detected: ${currentPhotoId} (was: ${baselinePhotoId})`);
              
              // Validate photo timing
              if (this.isPhotoValid(latestPhoto, commandStartTime)) {
                console.log(`✅ Photo validated for ${commandId}: ${currentPhotoId}`);
                return latestPhoto;
              } else {
                console.log(`⚠️ Photo timing invalid for ${commandId}, continuing search...`);
              }
            } else {
              console.log(`📸 Same photo as baseline (${currentPhotoId}), waiting for new one...`);
            }
          } else {
            console.log(`📸 No photo found, retrying...`);
          }
        }

      } catch (error) {
        console.error(`❌ Error in completion wait:`, error.message);
        throw error;
      }

      // Wait before next check
      await this.delay(CHECK_INTERVAL);
    }
  }

  // Simple photo validation - just check if it's recent enough
  isPhotoValid(photo, commandStartTime) {
    try {
      let photoTime = null;
      
      // Try to get photo timestamp from various sources
      if (photo.timeCreated) {
        photoTime = new Date(photo.timeCreated);
      } else if (photo.updated) {
        photoTime = new Date(photo.updated);
      } else {
        // Extract from filename
        const photoId = photo.name || photo.fileName || photo.id || '';
        const timestampMatch = photoId.match(/photo_(\d+)\.jpg/);
        if (timestampMatch) {
          photoTime = new Date(parseInt(timestampMatch[1]));
        }
      }
      
      if (!photoTime || isNaN(photoTime.getTime())) {
        console.log(`⚠️ Could not determine photo timestamp, accepting anyway`);
        return true; // Accept if we can't determine timestamp
      }
      
      const photoTimestamp = photoTime.getTime();
      const timeDiffFromCommand = photoTimestamp - commandStartTime;
      
      // Accept photos taken within reasonable time of command
      // Allow for timezone issues: accept from 1 hour before to 1 hour after command
      const isWithinRange = timeDiffFromCommand >= -3600000 && timeDiffFromCommand <= 3600000;
      
      console.log(`📸 Photo validation: ${Math.round(timeDiffFromCommand/1000)}s from command start (${isWithinRange ? 'VALID' : 'INVALID'})`);
      
      return isWithinRange;
      
    } catch (error) {
      console.log(`⚠️ Photo validation error: ${error.message}, accepting anyway`);
      return true; // Accept on validation error
    }
  }

  // Clean up after successful command
  async cleanupAfterSuccess() {
    try {
      console.log(`🧹 Success cleanup...`);
      
      // Clear command status (ESP32 should have done this, but ensure it's clear)
      await db.ref("checkCameraMoveCommand/status").set(0);
      
      // Clear camera busy flag
      await db.ref("deviceStatus/camera_busy").set(false);
      await db.ref("deviceStatus/camera_busy_timestamp").set(Date.now());
      
      console.log(`✅ Success cleanup completed`);
    } catch (error) {
      console.error(`❌ Success cleanup error:`, error);
    }
  }

  // Clean up after error
  async cleanupAfterError() {
    try {
      console.log(`🧹 Error cleanup...`);
      
      // Force clear all statuses
      await db.ref("checkCameraMoveCommand").set({
        commandId: null,
        moveServo: null,
        status: 0,
        timestamp: null,
        purpose: null
      });
      
      await db.ref("deviceStatus/camera_busy").set(false);
      await db.ref("deviceStatus/camera_busy_timestamp").set(Date.now());
      
      console.log(`✅ Error cleanup completed`);
    } catch (error) {
      console.error(`❌ Error cleanup failed:`, error);
    }
  }

  // Force cleanup command (for stuck situations)
  async forceCleanupCommand() {
    console.log(`🚨 Force cleaning up stuck command...`);
    
    await db.ref("checkCameraMoveCommand").set({
      commandId: null,
      moveServo: null,
      status: 0,
      timestamp: null,
      purpose: null
    });
    
    await db.ref("deviceStatus/camera_busy").set(false);
    await db.ref("deviceStatus/camera_busy_timestamp").set(Date.now());
  }

  // Track failures
  recordFailure(kolam) {
    const now = Date.now();
    if (!this.failedRequests.has(kolam)) {
      this.failedRequests.set(kolam, []);
    }
    
    const failures = this.failedRequests.get(kolam);
    failures.push(now);
    
    // Keep only failures from last 30 minutes
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    this.failedRequests.set(kolam, failures.filter(time => time > thirtyMinutesAgo));
    
    console.log(`📊 ${kolam} failure recorded. Recent failures: ${this.failedRequests.get(kolam).length}`);
  }

  // Get recent failure count
  getRecentFailures(kolam) {
    if (!this.failedRequests.has(kolam)) {
      return 0;
    }
    
    const now = Date.now();
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const recentFailures = this.failedRequests.get(kolam).filter(time => time > thirtyMinutesAgo);
    
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
      lastPhotoPerKolam: Object.fromEntries(this.lastPhotoPerKolam),
      lastRequestTime: Object.fromEntries(this.lastRequestTime),
      queuedRequests: this.queue.map(req => ({
        id: req.id,
        kolam: req.kolam,
        servoCommand: req.servoCommand,
        purpose: req.purpose,
        attempts: req.attempts,
        age: Math.round((now - req.createdAt) / 1000)
      })),
      recentFailures: Object.fromEntries(
        Array.from(this.failedRequests.entries()).map(([kolam, failures]) => [
          kolam, 
          failures.filter(time => now - time < 30 * 60 * 1000).length
        ])
      )
    };
  }

  // Clear queue
  clearQueue(reason = "Manual clear") {
    const rejectedCount = this.queue.length;
    this.queue.forEach(req => {
      req.reject(new Error(`Queue cleared: ${reason}`));
    });
    this.queue = [];
    
    this.processing = false;
    this.currentRequestId = null;
    
    console.log(`🧹 Queue cleared (${reason}). ${rejectedCount} requests rejected.`);
    return rejectedCount;
  }

  // Force complete current request
  async forceCompleteCurrentRequest(reason = "Force complete") {
    if (this.currentRequestId) {
      console.log(`🚨 Force completing: ${this.currentRequestId} (${reason})`);
      
      await this.cleanupAfterError();
      
      this.processing = false;
      this.currentRequestId = null;
      
      // Resume processing after delay
      setTimeout(() => {
        console.log("🔄 Resuming queue after force complete...");
        this.processQueue();
      }, 5000);
      
      return true;
    }
    return false;
  }

  // Restart queue
  async restartQueue() {
    console.log("🔄 Restarting queue...");
    
    const currentRequest = this.currentRequestId;
    const queueLength = this.queue.length;
    
    // Force complete current
    await this.forceCompleteCurrentRequest("Queue restart");
    
    // Clear failure tracking
    this.failedRequests.clear();
    
    console.log(`✅ Queue restarted. Previous: ${currentRequest}, Queue: ${queueLength}`);
    
    return {
      previousCurrentRequest: currentRequest,
      queueLength: queueLength,
      restarted: true
    };
  }
}

// ============= SINGLETON INSTANCE =============
const cameraQueue = new CameraFeedingQueue();

// Auto-restart mechanism for stuck queue
setInterval(async () => {
  const status = cameraQueue.getStatus();
  
  // Check for stuck processing
  if (status.processing && status.currentRequestId) {
    const currentRequest = status.queuedRequests.find(r => r.id === status.currentRequestId);
    if (currentRequest && currentRequest.age > 300) { // 5 minutes
      console.log("🚨 Queue stuck for 5+ minutes, auto-restarting...");
      await cameraQueue.restartQueue();
    }
  }
  
  // Clean up old photo tracking (older than 2 hours)
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [kolam, photoId] of cameraQueue.lastPhotoPerKolam.entries()) {
    const photoTimestamp = parseInt(photoId.match(/\d+/)?.[0] || "0");
    if (photoTimestamp < twoHoursAgo) {
      cameraQueue.lastPhotoPerKolam.delete(kolam);
      console.log(`🧹 Cleaned up old photo tracking for ${kolam}: ${photoId}`);
    }
  }
  
}, 5 * 60 * 1000); // Check every 5 minutes

// ============= PUBLIC API =============
async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
  const kolam = servoCommand.includes("170,140") ? "kolam1" : 
               servoCommand.includes("35,140") ? "kolam2" : "unknown";
               
  console.log(`📨 New ${kolam} camera request: ${servoCommand}, purpose: ${purpose} at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);
  
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
// const { db } = require("../config/firebase");
// const { getLatestPhotoFromGCS } = require("./uploadFishFood");
// const {storage, bucket} = require("../config/storage");
// // Helper function to convert UTC to WIB (UTC+7) for consistent timezone handling
// function toWIB(utcTimestamp) {
//   return new Date(utcTimestamp + (7 * 60 * 60 * 1000));
// }

// // Helper function to get current time in WIB for logging
// function getCurrentWIB() {
//   return toWIB(Date.now());
// }

// // ============= QUEUE SYSTEM =============
// class CameraFeedingQueue {
//   constructor() {
//     this.queue = [];
//     this.processing = false;
//     this.currentRequestId = null;
//     this.failedRequests = new Map();
//     this.photoReservations = new Map(); // Track which photos belong to which requests
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
//       console.log(`Request ${requestId} ditambahkan ke antrian. Queue length: ${this.queue.length} - Created at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);

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
//         if (requestAge > 18 * 60 * 1000) {
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

//         // Get baseline photo before sending command (to detect new photos) - USE DIRECT ACCESS
//         const baselinePhoto = await getLatestPhotoDirectFromGCS();
//         const baselinePhotoId = baselinePhoto ? (baselinePhoto.name || baselinePhoto.fileName || baselinePhoto.id) : null;
        
//         console.log(`📸 Baseline photo before command: ${baselinePhotoId}`);

//         // Eksekusi request dengan timeout
//         const result = await this.executeRequestWithTimeout(request, baselinePhotoId);
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
//           await this.delay(15000);
//           continue;
//         }
        
//         // Request failed permanently
//         this.recordFailure(`${request.servoCommand}-${request.purpose}`);
//         request.reject(error);
//       } 
      
//       // Reset current request
//       this.currentRequestId = null;
      
//       // Delay antar request untuk mencegah overload
//       await this.delay(20000);
//     }
    
//     this.processing = false;
//     console.log("✅ Semua request dalam antrian selesai diproses");
//   }

//   // Execute request with overall timeout
//   async executeRequestWithTimeout(request, baselinePhotoId) {
//     const TOTAL_TIMEOUT = 120000; // 2 minutes total timeout per request
    
//     return Promise.race([
//       this.executeRequest(request, baselinePhotoId),
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

//   // Eksekusi request individual - IMPROVED WITH STRICT PHOTO DETECTION
//   async executeRequest(request, baselinePhotoId) {
//     const commandId = request.id + `-attempt${request.attempts + 1}`;
    
//     try {
//       console.log(`📤 Sending command ${commandId}: ${request.servoCommand}`);

//       // Record the actual command start time for photo validation
//       const actualCommandStartTime = Date.now();

//       // 1. Kirim perintah dengan timestamp unik
//       await db.ref("checkCameraMoveCommand").set({
//         commandId: commandId,
//         moveServo: request.servoCommand,
//         status: 1,
//         timestamp: actualCommandStartTime,
//         purpose: request.purpose
//       });

//       // 2. Tunggu sampai selesai dengan monitoring yang lebih strict
//       const result = await this.waitForCompletionWithStrictTimeout(commandId, baselinePhotoId, actualCommandStartTime);

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

//   // Wait for completion with STRICT photo ownership
//   async waitForCompletionWithStrictTimeout(commandId, baselinePhotoId) {
//     const COMMAND_TIMEOUT = 30000; // 30 seconds for ESP32 to complete
//     const PHOTO_TIMEOUT = 60000;   // 60 seconds to find photo
//     const CHECK_INTERVAL = 1000;   // Check every 1 second
    
//     let commandStartTime = Date.now();
//     let commandCompleted = false;
//     let photoCheckStartTime = null;
    
//     console.log(`⏳ Waiting for command ${commandId} completion...`);
//     console.log(`📸 Baseline photo ID: ${baselinePhotoId}`);

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

//         // Phase 2: Wait for NEW photo after command completion
//         if (commandCompleted) {
//           // Check photo timeout
//           const photoWaitTime = now - photoCheckStartTime;
//           if (photoWaitTime > PHOTO_TIMEOUT) {
//             throw new Error(`Photo not found for ${commandId} after ${PHOTO_TIMEOUT}ms`);
//           }

//           console.log(`📸 Checking for NEW photo (${Math.round(photoWaitTime/1000)}s since completion)...`);
          
//           const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan1234');
          
//           if (latestPhoto) {
//             const currentPhotoId = latestPhoto.name || latestPhoto.fileName || latestPhoto.id || 'unknown';
            
//             // STRICT CHECK: Only accept if this is a NEW photo (different from baseline)
//             if (currentPhotoId !== baselinePhotoId) {
//               console.log(`📸 NEW photo detected: ${currentPhotoId} (baseline was: ${baselinePhotoId})`);
              
//               // Additional validation: photo should be recent enough
//               const isValidPhoto = this.validatePhotoTimestamp(latestPhoto, commandStartTime, now);
//               if (isValidPhoto.valid) {
//                 // Reserve this photo for this command to prevent other requests from taking it
//                 this.photoReservations.set(currentPhotoId, commandId);
//                 console.log(`📸 Photo reserved for ${commandId}: ${currentPhotoId} (${isValidPhoto.reason})`);
//                 return latestPhoto;
//               } else {
//                 console.log(`📸 NEW photo rejected due to timing: ${isValidPhoto.reason}`);
//               }
//             } else {
//               console.log(`📸 Same photo as baseline: ${currentPhotoId}, waiting for new upload...`);
//             }
//           } else {
//             console.log(`📸 No photo found in GCS`);
//           }
//         }

//       } catch (error) {
//         console.error(`❌ Error monitoring ${commandId}:`, error.message);
//         throw error;
//       }

//       await this.delay(CHECK_INTERVAL);
//     }
//   }

//   // Smart photo validation with timezone handling for Indonesia (UTC+7)
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
      
//       // Convert to Indonesia time for logging (UTC+7)
//       const photoTimeWIB = new Date(photoTimestamp + (7 * 60 * 60 * 1000));
//       const commandStartWIB = new Date(commandStartTime + (7 * 60 * 60 * 1000));
//       const currentTimeWIB = new Date(currentTime + (7 * 60 * 60 * 1000));
      
//       console.log(`📸 Photo validation (${timestampSource}):
//         - Photo time UTC: ${photoTime.toISOString()}
//         - Photo time WIB: ${photoTimeWIB.toISOString()}
//         - Command start UTC: ${new Date(commandStartTime).toISOString()}
//         - Command start WIB: ${commandStartWIB.toISOString()}
//         - Current time UTC: ${new Date(currentTime).toISOString()}
//         - Current time WIB: ${currentTimeWIB.toISOString()}
//         - Diff from command: ${Math.round(timeDiffFromCommand/1000)}s
//         - Diff from now: ${Math.round(timeDiffFromNow/1000)}s`);
      
//       // Strategy 1: Photo taken after command started (handle timezone differences)
//       // Allow for timezone confusion: -7 hours to +1 hour from command time
//       if (timeDiffFromCommand >= -25200000 && timeDiffFromCommand <= 3600000) { // -7h to +1h from command
//         return { valid: true, reason: `photo taken ${Math.round(timeDiffFromCommand/1000)}s after command - timezone tolerant (${timestampSource})` };
//       }
      
//       // Strategy 2: Photo is very recent relative to current time (handle timezone issues)
//       // Allow photos that are within 8 hours in either direction (timezone confusion)
//       if (Math.abs(timeDiffFromNow) <= 8 * 60 * 60 * 1000) { // Within 8 hours of current time (either direction)
//         return { valid: true, reason: `recent photo ${Math.round(timeDiffFromNow/1000)}s from now - timezone tolerant (${timestampSource})` };
//       }
      
//       // Strategy 3: Special case for filename timestamps (these are usually more reliable)
//       if (timestampSource === 'filename') {
//         // For filename timestamps, be more lenient as they're often in local time
//         if (Math.abs(timeDiffFromCommand) <= 10 * 60 * 1000) { // Within 10 minutes of command
//           return { valid: true, reason: `filename timestamp within 10 minutes of command (${timestampSource})` };
//         }
        
//         // Also check if photo timestamp is "in the future" compared to server time
//         // This often indicates timezone mismatch where device is in WIB but server in UTC
//         if (timeDiffFromNow < 0 && Math.abs(timeDiffFromNow) <= 8 * 60 * 60 * 1000) {
//           return { valid: true, reason: `future photo likely due to timezone diff ${Math.round(timeDiffFromNow/3600000)}h ahead (${timestampSource})` };
//         }
//       }
      
//       return { 
//         valid: false, 
//         reason: `photo timing invalid: ${Math.round(timeDiffFromCommand/1000)}s from command, ${Math.round(timeDiffFromNow/1000)}s from now (${timestampSource})` 
//       };
      
//     } catch (error) {
//       console.error("Error validating photo timestamp:", error);
//       return { valid: false, reason: `validation error: ${error.message}` };
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
//       photoReservations: Object.fromEntries(this.photoReservations),
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
    
//     // Clear photo reservations
//     this.photoReservations.clear();
    
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
    
//     // Clear failed requests cache and photo reservations
//     this.failedRequests.clear();
//     this.photoReservations.clear();
    
//     console.log(`✅ Queue restarted. Previous current: ${currentRequest}, Queue length: ${queueLength}`);
    
//     return {
//       previousCurrentRequest: currentRequest,
//       queueLength: queueLength,
//       restarted: true
//     };
//   }
// }

// // ============= HELPER FUNCTIONS OUTSIDE CLASS =============

// // Direct GCS access without polling flag interference
// async function getLatestPhotoDirectFromGCS() {
//   try {
//     const { bucket } = require("../config/storage");
//     if (!bucket) {
//       console.log(`📸 Bucket not found in config/storage, using fallback...`);
//       return await getLatestPhotoWithTimeout();
//     }

//     const [files] = await bucket.getFiles({ prefix: 'photo_' });
//     if (!files.length) {
//       console.log(`📸 No photos found in GCS bucket`);
//       return null;
//     }

//     // Urutkan berdasarkan timestamp pada nama file
//     files.sort((a, b) => {
//       const aTime = parseInt(a.name.match(/\d+/)?.[0] || "0");
//       const bTime = parseInt(b.name.match(/\d+/)?.[0] || "0");
//       return bTime - aTime;
//     });

//     const latestFile = files[0];
//     const [buffer] = await latestFile.download();

//     console.log(`📸 Direct GCS fetch successful: ${latestFile.name}`);
//     return { buffer, fileName: latestFile.name };

//   } catch (error) {
//     console.log(`📸 Direct GCS access failed (${error.message}), using fallback...`);
//     return await getLatestPhotoWithTimeout();
//   }
// }

// // Fallback method with timeout to prevent infinite waiting
// async function getLatestPhotoWithTimeout() {
//   const PHOTO_FETCH_TIMEOUT = 5000; // 5 seconds timeout
  
//   try {
//     console.log(`📸 Using fallback getLatestPhotoFromGCS with timeout...`);
    
//     const timeoutPromise = new Promise((_, reject) => 
//       setTimeout(() => reject(new Error('Photo fetch timeout')), PHOTO_FETCH_TIMEOUT)
//     );

//     const photoPromise = getLatestPhotoFromGCS('pakan-ikan1234');

//     const result = await Promise.race([photoPromise, timeoutPromise]);
//     return result;
    
//   } catch (error) {
//     console.log(`⚠️ Fallback photo fetch failed: ${error.message}`);
//     return null;
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
//         console.log(`📨 New camera request: ${servoCommand}, purpose: ${purpose} at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);
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