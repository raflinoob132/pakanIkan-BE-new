const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("./uploadFishFood");
const {storage, bucket} = require("../config/storage");

// ============= UNIFIED COMMAND SYSTEM =============
class CommandTracker {
  constructor() {
    this.activeCommands = new Map();
  }

  createCommand(servoCommand, purpose = "makanan") {
    const timestamp = Date.now();
    const deviceId = "main";
    const commandId = `${timestamp}-${deviceId}-${purpose}`;
    
    const command = {
      id: commandId,
      servoCommand,
      purpose,
      phase: 'queued',
      timestamp,
      retryCount: 0,
      maxRetries: 3,
      createdAt: timestamp,
      baselinePhotoId: null,
      expectedPhotoPattern: `photo_${timestamp.toString().substring(0, 10)}` // First 10 digits for matching
    };

    this.activeCommands.set(commandId, command);
    return command;
  }

  updateCommandPhase(commandId, phase, metadata = {}) {
    const command = this.activeCommands.get(commandId);
    if (command) {
      command.phase = phase;
      command.lastUpdate = Date.now();
      Object.assign(command, metadata);
      
      console.log(`📋 Command ${commandId} → ${phase}`, metadata);
      return true;
    }
    return false;
  }

  getCommand(commandId) {
    return this.activeCommands.get(commandId);
  }

  removeCommand(commandId) {
    return this.activeCommands.delete(commandId);
  }

  getActiveCommands() {
    return Array.from(this.activeCommands.values());
  }
}

// Helper function to convert UTC to WIB (UTC+7) for consistent timezone handling
function toWIB(utcTimestamp) {
  return new Date(utcTimestamp + (7 * 60 * 60 * 1000));
}

function getCurrentWIB() {
  return toWIB(Date.now());
}

// ============= IMPROVED QUEUE SYSTEM =============
class CameraFeedingQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentRequestId = null;
    this.failedRequests = new Map();
    this.commandTracker = new CommandTracker();
    this.photoCache = new Map(); // Cache recent photos
  }

  // Simplified request addition with unified command tracking
  async addRequest(servoCommand, purpose = "makanan") {
    return new Promise((resolve, reject) => {
      const command = this.commandTracker.createCommand(servoCommand, purpose);

      const request = {
        id: command.id,
        servoCommand,
        purpose,
        resolve,
        reject,
        command,
        attempts: 0,
        maxAttempts: 3
      };

      this.queue.push(request);
      console.log(`📥 Request ${command.id} queued. Queue length: ${this.queue.length} - Created at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);

      this.processQueue();
    });
  }

  // Enhanced queue processing with better tracking
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      this.currentRequestId = request.id;
      
      console.log(`🔄 Processing request ${request.id} - Servo: ${request.servoCommand} (attempt ${request.attempts + 1}/${request.maxAttempts})`);
      
      try {
        // Update command phase
        this.commandTracker.updateCommandPhase(request.id, 'processing');

        // Check if request is too old
        const requestAge = Date.now() - request.command.createdAt;
        if (requestAge > 10 * 60 * 1000) {
          throw new Error(`Request expired: ${Math.round(requestAge / 60000)} minutes old`);
        }

        // Check recent failures
        const failureKey = `${request.servoCommand}-${request.purpose}`;
        const recentFailures = this.getRecentFailures(failureKey);
        if (recentFailures >= 5) {
          throw new Error(`Too many recent failures for command ${request.servoCommand}. Skipping.`);
        }

        // Check ESP32 status
        const busyCheck = await this.checkESP32Status();
        if (busyCheck.isBusy) {
          throw new Error(`ESP32 busy: ${busyCheck.reason}`);
        }

        // Get baseline photo with simplified detection
        const baselinePhoto = await this.getBaselinePhotoSimplified();
        request.command.baselinePhotoId = baselinePhoto?.id || null;
        
        console.log(`📸 Baseline photo: ${request.command.baselinePhotoId}`);

        // Execute request with unified tracking
        const result = await this.executeRequestWithUnifiedTracking(request);
        request.resolve(result);
        
        console.log(`✅ Request ${request.id} completed successfully`);
        this.commandTracker.updateCommandPhase(request.id, 'completed');
        
      } catch (error) {
        console.error(`❌ Request ${request.id} failed:`, error.message);
        
        request.attempts++;
        this.commandTracker.updateCommandPhase(request.id, 'failed', { 
          error: error.message, 
          attempt: request.attempts 
        });
        
        // Retry logic
        if (request.attempts < request.maxAttempts && 
            !error.message.includes('expired') && 
            !error.message.includes('Too many recent failures')) {
          
          console.log(`🔄 Retrying request ${request.id} (${request.attempts}/${request.maxAttempts})`);
          this.commandTracker.updateCommandPhase(request.id, 'retrying');
          this.queue.unshift(request);
          await this.delay(5000);
          continue;
        }
        
        // Request failed permanently
        this.recordFailure(`${request.servoCommand}-${request.purpose}`);
        this.commandTracker.removeCommand(request.id);
        request.reject(error);
      } 
      
      this.currentRequestId = null;
      await this.delay(3000); // Reduced delay
    }
    
    this.processing = false;
    console.log("✅ Queue processing completed");
  }

  // Simplified baseline photo detection
  async getBaselinePhotoSimplified() {
    try {
      const { bucket } = require("../config/storage");
      if (!bucket) {
        console.log(`📸 Bucket not available, skipping baseline`);
        return null;
      }

      const [files] = await bucket.getFiles({ 
        prefix: 'photo_',
        maxResults: 1,
        orderBy: 'timeCreated desc'
      });

      if (files.length === 0) {
        console.log(`📸 No photos in bucket`);
        return null;
      }

      const latestFile = files[0];
      const photoId = this.extractPhotoId(latestFile.name);
      
      console.log(`📸 Latest photo ID: ${photoId}`);
      return { id: photoId, file: latestFile };

    } catch (error) {
      console.log(`📸 Baseline photo error: ${error.message}`);
      return null;
    }
  }

  // Extract consistent photo ID from filename
  extractPhotoId(filename) {
    const match = filename.match(/photo_(\d+)\.jpg/);
    return match ? match[1] : filename;
  }

  // Execute request with unified command tracking
  async executeRequestWithUnifiedTracking(request) {
    const TOTAL_TIMEOUT = 60000; // Reduced to 1 minute
    
    this.commandTracker.updateCommandPhase(request.id, 'camera');
    
    return Promise.race([
      this.executeRequestSimplified(request),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Request ${request.id} timeout after ${TOTAL_TIMEOUT}ms`)), TOTAL_TIMEOUT)
      )
    ]);
  }

  // Simplified request execution
  async executeRequestSimplified(request) {
    try {
      console.log(`📤 Sending command: ${request.id}`);

      const actualCommandStartTime = Date.now();
      
      // Send Firebase command with unified ID
      await db.ref("checkCameraMoveCommand").set({
        commandId: request.id, // Use unified command ID
        moveServo: request.servoCommand,
        status: 1,
        timestamp: actualCommandStartTime,
        purpose: request.purpose
      });

      this.commandTracker.updateCommandPhase(request.id, 'waiting_completion');

      // Wait for completion with simplified photo detection
      const result = await this.waitForCompletionSimplified(request, actualCommandStartTime);

      await this.cleanupCommand();
      return result;

    } catch (error) {
      console.error(`❌ Execute request failed: ${error.message}`);
      await this.cleanupCommand();
      throw error;
    }
  }

  // Simplified completion waiting with better photo detection
  async waitForCompletionSimplified(request, commandStartTime) {
    const COMMAND_TIMEOUT = 25000; // 25 seconds for ESP32
    const PHOTO_TIMEOUT = 35000;   // 35 seconds for photo
    const CHECK_INTERVAL = 2000;   // Check every 2 seconds
    
    let commandCompleted = false;
    let photoCheckStartTime = null;
    
    console.log(`⏳ Waiting for command ${request.id} completion...`);

    while (true) {
      const now = Date.now();
      
      try {
        // Phase 1: Wait for ESP32 command completion
        if (!commandCompleted) {
          if (now - commandStartTime > COMMAND_TIMEOUT) {
            throw new Error(`Command timeout - ESP32 not responding`);
          }

          const snap = await db.ref("checkCameraMoveCommand").once("value");
          const commandData = snap.val();
          
          if (!commandData || commandData.commandId !== request.id) {
            throw new Error(`Command data corrupted or not found`);
          }

          if (commandData.status === 0) {
            console.log(`✅ Command ${request.id} completed by ESP32`);
            commandCompleted = true;
            photoCheckStartTime = now;
            this.commandTracker.updateCommandPhase(request.id, 'waiting_photo');
          }
        }

        // Phase 2: Simplified photo detection
        if (commandCompleted) {
          const photoWaitTime = now - photoCheckStartTime;
          if (photoWaitTime > PHOTO_TIMEOUT) {
            throw new Error(`Photo not found after ${PHOTO_TIMEOUT}ms`);
          }

          console.log(`📸 Checking for new photo (${Math.round(photoWaitTime/1000)}s)...`);
          
          const newPhoto = await this.detectNewPhotoSimplified(request);
          
          if (newPhoto) {
            console.log(`📸 New photo detected: ${newPhoto.id}`);
            this.commandTracker.updateCommandPhase(request.id, 'photo_received', { 
              photoId: newPhoto.id 
            });
            return newPhoto.data;
          }
        }

      } catch (error) {
        console.error(`❌ Error monitoring ${request.id}:`, error.message);
        throw error;
      }

      await this.delay(CHECK_INTERVAL);
    }
  }

  // Simplified new photo detection
  async detectNewPhotoSimplified(request) {
    try {
      const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan1234');
      
      if (!latestPhoto) {
        return null;
      }

      // Extract photo ID consistently
      const currentPhotoId = this.extractPhotoId(
        latestPhoto.name || latestPhoto.fileName || latestPhoto.id || 'unknown'
      );
      
      // Simple comparison with baseline
      if (currentPhotoId !== request.command.baselinePhotoId) {
        // Additional validation: check if photo timestamp makes sense
        const photoTimestamp = parseInt(currentPhotoId);
        const commandTimestamp = request.command.timestamp;
        
        // Photo should be taken after command started (with tolerance)
        if (photoTimestamp >= commandTimestamp - 300000) { // 5 min tolerance
          console.log(`📸 Valid new photo: ${currentPhotoId} (baseline: ${request.command.baselinePhotoId})`);
          return { id: currentPhotoId, data: latestPhoto };
        } else {
          console.log(`📸 Photo timestamp invalid: ${photoTimestamp} vs command: ${commandTimestamp}`);
        }
      } else {
        console.log(`📸 Same photo as baseline: ${currentPhotoId}`);
      }

      return null;
    } catch (error) {
      console.error("Photo detection error:", error);
      return null;
    }
  }

  // Check ESP32 status with heartbeat
  async checkESP32Status() {
    try {
      // Check camera busy status
      const statusSnap = await db.ref("deviceStatus/camera_busy").once("value");
      const isCameraBusy = statusSnap.val() === true || statusSnap.val() === "true";
      
      if (isCameraBusy) {
        return { isBusy: true, reason: "Camera in use" };
      }

      // Check pending commands
      const commandSnap = await db.ref("checkCameraMoveCommand/status").once("value");
      const commandStatus = commandSnap.val();
      
      if (commandStatus === 1) {
        return { isBusy: true, reason: "Command pending" };
      }

      // Check device heartbeat (optional)
      const heartbeatSnap = await db.ref("devices/esp32cam/heartbeat").once("value");
      const lastHeartbeat = heartbeatSnap.val();
      
      if (lastHeartbeat && (Date.now() - lastHeartbeat > 60000)) {
        console.log("⚠️ Device heartbeat is stale");
      }

      return { isBusy: false };
    } catch (error) {
      return { isBusy: true, reason: `Status check error: ${error.message}` };
    }
  }

  // Clean up command
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
      console.error("❌ Cleanup failed:", error.message);
    }
  }

  // Track failures
  recordFailure(key) {
    const now = Date.now();
    if (!this.failedRequests.has(key)) {
      this.failedRequests.set(key, []);
    }
    
    const failures = this.failedRequests.get(key);
    failures.push(now);
    
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    this.failedRequests.set(key, failures.filter(time => time > thirtyMinutesAgo));
  }

  getRecentFailures(key) {
    if (!this.failedRequests.has(key)) {
      return 0;
    }
    
    const now = Date.now();
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const recentFailures = this.failedRequests.get(key).filter(time => time > thirtyMinutesAgo);
    
    return recentFailures.length;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Enhanced status with command tracking
  getStatus() {
    const now = Date.now();
    const activeCommands = this.commandTracker.getActiveCommands();
    
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentRequestId: this.currentRequestId,
      activeCommands: activeCommands.map(cmd => ({
        id: cmd.id,
        phase: cmd.phase,
        purpose: cmd.purpose,
        age: Math.round((now - cmd.createdAt) / 1000),
        retryCount: cmd.retryCount,
        baselinePhotoId: cmd.baselinePhotoId
      })),
      queuedRequests: this.queue.map(req => ({
        id: req.id,
        servoCommand: req.servoCommand,
        purpose: req.purpose,
        attempts: req.attempts,
        age: Math.round((now - req.command.createdAt) / 1000)
      })),
      recentFailures: Object.fromEntries(this.failedRequests)
    };
  }

  // Improved queue management
  clearQueue(reason = "Manual clear") {
    const rejectedCount = this.queue.length;
    this.queue.forEach(req => {
      this.commandTracker.updateCommandPhase(req.id, 'cancelled', { reason });
      req.reject(new Error(`Queue cleared: ${reason}`));
    });
    this.queue = [];
    
    this.processing = false;
    this.currentRequestId = null;
    
    console.log(`🧹 Queue cleared (${reason}). ${rejectedCount} requests cancelled.`);
    return rejectedCount;
  }

  async restartQueue() {
    console.log("🔄 Restarting queue system...");
    
    const currentRequest = this.currentRequestId;
    const queueLength = this.queue.length;
    
    // Clean up current state
    await this.cleanupCommand();
    this.processing = false;
    this.currentRequestId = null;
    
    // Clear caches
    this.failedRequests.clear();
    this.photoCache.clear();
    
    console.log(`✅ Queue restarted. Previous: ${currentRequest}, Queue: ${queueLength}`);
    
    // Resume processing if there are queued requests
    if (this.queue.length > 0) {
      setTimeout(() => this.processQueue(), 1000);
    }
    
    return {
      previousCurrentRequest: currentRequest,
      queueLength: queueLength,
      restarted: true
    };
  }
}

// ============= SINGLETON INSTANCE =============
const cameraQueue = new CameraFeedingQueue();

// Enhanced auto-restart with command tracking
setInterval(async () => {
  const status = cameraQueue.getStatus();
  
  // Check for stuck processing
  if (status.processing && status.currentRequestId) {
    const currentCommand = status.activeCommands.find(cmd => cmd.id === status.currentRequestId);
    if (currentCommand && currentCommand.age > 300) { // 5 minutes
      console.log("🚨 Stuck queue detected, auto-restarting...");
      await cameraQueue.restartQueue();
    }
  }
  
  // Clean up old commands
  const activeCommands = cameraQueue.commandTracker.getActiveCommands();
  activeCommands.forEach(cmd => {
    if (cmd.phase === 'completed' || cmd.phase === 'cancelled') {
      const age = Date.now() - cmd.createdAt;
      if (age > 10 * 60 * 1000) { // 10 minutes old
        cameraQueue.commandTracker.removeCommand(cmd.id);
      }
    }
  });
  
}, 2 * 60 * 1000); // Check every 2 minutes

// ============= PUBLIC API =============
async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
  console.log(`📨 New camera request: ${servoCommand}, purpose: ${purpose} at ${getCurrentWIB().toISOString().replace('T', ' ').slice(0, 19)} WIB`);
  return await cameraQueue.addRequest(servoCommand, purpose);
}

function getQueueStatus() {
  return cameraQueue.getStatus();
}

function clearQueue(reason) {
  return cameraQueue.clearQueue(reason);
}

function restartQueue() {
  return cameraQueue.restartQueue();
}

// New: Get command details
function getCommandDetails(commandId) {
  return cameraQueue.commandTracker.getCommand(commandId);
}

// ============= EXPORTS =============
module.exports = { 
  triggerCameraAndWait,
  getQueueStatus,
  clearQueue,
  restartQueue,
  getCommandDetails
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