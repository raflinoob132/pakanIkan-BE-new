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
    this.photoReservations = new Map(); // Track which photos belong to which requests
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

        // Get baseline photo before sending command (to detect new photos) - USE DIRECT ACCESS
        const baselinePhoto = await getLatestPhotoDirectFromGCS();
        const baselinePhotoId = baselinePhoto ? (baselinePhoto.name || baselinePhoto.fileName || baselinePhoto.id) : null;
        
        console.log(`📸 Baseline photo before command: ${baselinePhotoId}`);

        // Eksekusi request dengan timeout
        const result = await this.executeRequestWithTimeout(request, baselinePhotoId, commandStartTimestamp);
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
          await this.delay(3000);
          continue;
        }
        
        // Request failed permanently
        this.recordFailure(`${request.servoCommand}-${request.purpose}`);
        request.reject(error);
      } 
      
      // Reset current request
      this.currentRequestId = null;
      
      // Delay antar request untuk mencegah overload
      await this.delay(2000);
    }
    
    this.processing = false;
    console.log("✅ Semua request dalam antrian selesai diproses");
  }

  // Execute request with overall timeout
  async executeRequestWithTimeout(request, baselinePhotoId, commandStartTimestamp) {
    const TOTAL_TIMEOUT = 120000; // 2 minutes total timeout per request
    
    return Promise.race([
      this.executeRequest(request, baselinePhotoId, commandStartTimestamp),
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

  // Eksekusi request individual - IMPROVED WITH STRICT PHOTO DETECTION
  async executeRequest(request, baselinePhotoId, commandStartTimestamp) {
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

      // 2. Tunggu sampai selesai dengan monitoring yang lebih strict
      const result = await this.waitForCompletionWithStrictTimeout(commandId, baselinePhotoId, commandStartTimestamp);

      // 3. Bersihkan command
      await this.cleanupCommand();

      return result;

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

  // Wait for completion with STRICT photo ownership
  async waitForCompletionWithStrictTimeout(commandId, baselinePhotoId) {
    const COMMAND_TIMEOUT = 30000; // 30 seconds for ESP32 to complete
    const PHOTO_TIMEOUT = 60000;   // 60 seconds to find photo
    const CHECK_INTERVAL = 1000;   // Check every 1 second
    
    let commandStartTime = Date.now();
    let commandCompleted = false;
    let photoCheckStartTime = null;
    
    console.log(`⏳ Waiting for command ${commandId} completion...`);
    console.log(`📸 Baseline photo ID: ${baselinePhotoId}`);

    while (true) {
      const now = Date.now();
      
      try {
        // Phase 1: Wait for ESP32 to complete command
        if (!commandCompleted) {
          // Check command timeout
          if (now - commandStartTime > COMMAND_TIMEOUT) {
            throw new Error(`Command ${commandId} timeout - ESP32 tidak merespons dalam ${COMMAND_TIMEOUT}ms`);
          }

          const snap = await db.ref("checkCameraMoveCommand").once("value");
          const commandData = snap.val();
          
          if (!commandData || commandData.commandId !== commandId) {
            throw new Error(`Command ${commandId} data corrupted or not found`);
          }

          // Check if command completed
          if (commandData.status === 0) {
            console.log(`✅ Command ${commandId} completed by ESP32`);
            commandCompleted = true;
            photoCheckStartTime = now;
          }
        }

        // Phase 2: Wait for NEW photo after command completion
        if (commandCompleted) {
          // Check photo timeout
          const photoWaitTime = now - photoCheckStartTime;
          if (photoWaitTime > PHOTO_TIMEOUT) {
            throw new Error(`Photo not found for ${commandId} after ${PHOTO_TIMEOUT}ms`);
          }

          console.log(`📸 Checking for NEW photo (${Math.round(photoWaitTime/1000)}s since completion)...`);
          
          const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
          
          if (latestPhoto) {
            const currentPhotoId = latestPhoto.name || latestPhoto.fileName || latestPhoto.id || 'unknown';
            
            // STRICT CHECK: Only accept if this is a NEW photo (different from baseline)
            if (currentPhotoId !== baselinePhotoId) {
              console.log(`📸 NEW photo detected: ${currentPhotoId} (baseline was: ${baselinePhotoId})`);
              
              // Additional validation: photo should be recent enough
              const isValidPhoto = this.validatePhotoTimestamp(latestPhoto, commandStartTime, now);
              if (isValidPhoto.valid) {
                // Reserve this photo for this command to prevent other requests from taking it
                this.photoReservations.set(currentPhotoId, commandId);
                console.log(`📸 Photo reserved for ${commandId}: ${currentPhotoId} (${isValidPhoto.reason})`);
                return latestPhoto;
              } else {
                console.log(`📸 NEW photo rejected due to timing: ${isValidPhoto.reason}`);
              }
            } else {
              console.log(`📸 Same photo as baseline: ${currentPhotoId}, waiting for new upload...`);
            }
          } else {
            console.log(`📸 No photo found in GCS`);
          }
        }

      } catch (error) {
        console.error(`❌ Error monitoring ${commandId}:`, error.message);
        throw error;
      }

      await this.delay(CHECK_INTERVAL);
    }
  }

  // Smart photo validation with timezone handling for Indonesia (UTC+7)
  validatePhotoTimestamp(photo, commandStartTime, currentTime) {
    try {
      // Try multiple timestamp properties and formats
      let photoTime = null;
      let timestampSource = '';
      
      // Try different timestamp properties
      if (photo.timeCreated) {
        photoTime = new Date(photo.timeCreated);
        timestampSource = 'timeCreated';
      } else if (photo.updated) {
        photoTime = new Date(photo.updated);
        timestampSource = 'updated';
      } else if (photo.created) {
        photoTime = new Date(photo.created);
        timestampSource = 'created';
      } else if (photo.lastModified) {
        photoTime = new Date(photo.lastModified);
        timestampSource = 'lastModified';
      } else {
        // Fallback: try to extract timestamp from filename
        const photoId = photo.name || photo.fileName || photo.id || '';
        const timestampMatch = photoId.match(/photo_(\d+)\.jpg/);
        if (timestampMatch) {
          photoTime = new Date(parseInt(timestampMatch[1]));
          timestampSource = 'filename';
        }
      }
      
      // Handle invalid timestamps
      if (!photoTime || isNaN(photoTime.getTime())) {
        console.log(`📸 Available photo properties:`, Object.keys(photo));
        return { valid: false, reason: `Invalid photo timestamp from ${timestampSource}` };
      }
      
      const photoTimestamp = photoTime.getTime();
      const timeDiffFromCommand = photoTimestamp - commandStartTime;
      const timeDiffFromNow = currentTime - photoTimestamp;
      
      // Convert to Indonesia time for logging (UTC+7)
      const photoTimeWIB = new Date(photoTimestamp + (7 * 60 * 60 * 1000));
      const commandStartWIB = new Date(commandStartTime + (7 * 60 * 60 * 1000));
      const currentTimeWIB = new Date(currentTime + (7 * 60 * 60 * 1000));
      
      console.log(`📸 Photo validation (${timestampSource}):
        - Photo time UTC: ${photoTime.toISOString()}
        - Photo time WIB: ${photoTimeWIB.toISOString()}
        - Command start UTC: ${new Date(commandStartTime).toISOString()}
        - Command start WIB: ${commandStartWIB.toISOString()}
        - Current time UTC: ${new Date(currentTime).toISOString()}
        - Current time WIB: ${currentTimeWIB.toISOString()}
        - Diff from command: ${Math.round(timeDiffFromCommand/1000)}s
        - Diff from now: ${Math.round(timeDiffFromNow/1000)}s`);
      
      // Strategy 1: Photo taken after command started (handle timezone differences)
      // Allow for timezone confusion: -7 hours to +1 hour from command time
      if (timeDiffFromCommand >= -25200000 && timeDiffFromCommand <= 3600000) { // -7h to +1h from command
        return { valid: true, reason: `photo taken ${Math.round(timeDiffFromCommand/1000)}s after command - timezone tolerant (${timestampSource})` };
      }
      
      // Strategy 2: Photo is very recent relative to current time (handle timezone issues)
      // Allow photos that are within 8 hours in either direction (timezone confusion)
      if (Math.abs(timeDiffFromNow) <= 8 * 60 * 60 * 1000) { // Within 8 hours of current time (either direction)
        return { valid: true, reason: `recent photo ${Math.round(timeDiffFromNow/1000)}s from now - timezone tolerant (${timestampSource})` };
      }
      
      // Strategy 3: Special case for filename timestamps (these are usually more reliable)
      if (timestampSource === 'filename') {
        // For filename timestamps, be more lenient as they're often in local time
        if (Math.abs(timeDiffFromCommand) <= 10 * 60 * 1000) { // Within 10 minutes of command
          return { valid: true, reason: `filename timestamp within 10 minutes of command (${timestampSource})` };
        }
        
        // Also check if photo timestamp is "in the future" compared to server time
        // This often indicates timezone mismatch where device is in WIB but server in UTC
        if (timeDiffFromNow < 0 && Math.abs(timeDiffFromNow) <= 8 * 60 * 60 * 1000) {
          return { valid: true, reason: `future photo likely due to timezone diff ${Math.round(timeDiffFromNow/3600000)}h ahead (${timestampSource})` };
        }
      }
      
      return { 
        valid: false, 
        reason: `photo timing invalid: ${Math.round(timeDiffFromCommand/1000)}s from command, ${Math.round(timeDiffFromNow/1000)}s from now (${timestampSource})` 
      };
      
    } catch (error) {
      console.error("Error validating photo timestamp:", error);
      return { valid: false, reason: `validation error: ${error.message}` };
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

  // Get queue status with more details
  getStatus() {
    const now = Date.now();
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentRequestId: this.currentRequestId,
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
    // Try to import bucket from uploadFishFood module
    let bucket;
    try {
      const uploadModule = require("./uploadFishFood");
      bucket = uploadModule.bucket;
      
      if (!bucket) {
        console.log(`📸 Bucket not exported from uploadFishFood, using fallback...`);
        return await getLatestPhotoWithTimeout();
      }
      
    } catch (importError) {
      console.log(`📸 Cannot import bucket directly, using fallback method...`);
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
  const PHOTO_FETCH_TIMEOUT = 5000; // 5 seconds timeout
  
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