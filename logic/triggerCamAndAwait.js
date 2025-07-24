// const { db } = require("../config/firebase");
// const { getLatestPhotoFromGCS } = require("./uploadFishFood");

// // ============= QUEUE SYSTEM =============
// class CameraFeedingQueue {
//   constructor() {
//     this.queue = [];
//     this.processing = false;
//     this.currentRequestId = null;
//     this.lock = false; // Tambah lock mechanism
//     this.maxQueueSize = 10; // Prevent memory issues
//   }

//   // Tambah request ke antrian
//   async addRequest(servoCommand, purpose = "makanan") {
//     // Check queue size limit
//     if (this.queue.length >= this.maxQueueSize) {
//       throw new Error(`Queue full (${this.maxQueueSize}). Please try again later.`);
//     }

//     return new Promise((resolve, reject) => {
//       const requestId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);

//       // Tambah timeout untuk promise
//       const timeout = setTimeout(() => {
//         // Remove from queue if still there
//         const index = this.queue.findIndex(req => req.id === requestId);
//         if (index > -1) {
//           this.queue.splice(index, 1);
//         }
//         reject(new Error(`Request ${requestId} timeout after 2 minutes`));
//       }, 120000); // 2 minutes

//       const request = {
//         id: requestId,
//         servoCommand,
//         purpose,
//         resolve: (result) => {
//           clearTimeout(timeout);
//           resolve(result);
//         },
//         reject: (error) => {
//           clearTimeout(timeout);
//           reject(error);
//         },
//         timestamp: Date.now(),
//         attempts: 0,
//         maxAttempts: 3
//       };

//       this.queue.push(request);
//       console.log(`Request ${requestId} queued. Position: ${this.queue.length}`);

//       this.processQueue();
//     });
//   }

//   // Priority queue for urgent requests
//   addUrgentRequest(servoCommand, purpose = "urgent") {
//     return new Promise((resolve, reject) => {
//       const requestId = 'URGENT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

//       const request = {
//         id: requestId,
//         servoCommand,
//         purpose,
//         resolve,
//         reject,
//         timestamp: Date.now(),
//         attempts: 0,
//         maxAttempts: 3,
//         urgent: true
//       };

//       // Add to front of queue
//       this.queue.unshift(request);
//       console.log(`🚨 URGENT request ${requestId} added to front of queue`);

//       this.processQueue();
//     });
//   }

//   // Proses antrian satu per satu
//   async processQueue() {
//     if (this.processing || this.queue.length === 0 || this.lock) {
//       return;
//     }

//     this.processing = true;

//     while (this.queue.length > 0) {
//       const request = this.queue[0]; // Peek, don't shift yet
//       this.currentRequestId = request.id;

//       try {
//         // Atomic lock check
//         if (this.lock) {
//           await this.delay(1000);
//           continue;
//         }

//         this.lock = true; // Lock before status check

//         const busyCheck = await this.checkESP32Status();
//         if (busyCheck.isBusy) {
//           this.lock = false;
//           throw new Error(`ESP32 busy: ${busyCheck.reason}`);
//         }

//         // Now shift from queue since we're committed
//         this.queue.shift();

//         const result = await this.executeRequestWithRetry(request);
//         this.lock = false;

//         request.resolve(result);
//         console.log(`✅ Request ${request.id} completed successfully`);

//       } catch (error) {
//         this.lock = false;

//         // Handle retry logic
//         request.attempts++;
//         if (request.attempts < request.maxAttempts) {
//           console.log(`🔄 Retrying request ${request.id} (${request.attempts}/${request.maxAttempts})`);
//           // Put back to front of queue for retry
//           this.queue.unshift(request);
//           await this.delay(5000); // Wait before retry
//         } else {
//           // Remove from queue and reject
//           const index = this.queue.findIndex(req => req.id === request.id);
//           if (index > -1) this.queue.splice(index, 1);

//           console.error(`❌ Request ${request.id} failed permanently:`, error.message);
//           request.reject(error);
//         }
//       }

//       await this.delay(2000); // Inter-request delay
//     }

//     this.processing = false;
//     this.currentRequestId = null;
//     console.log("✅ All queue requests processed");
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

//   // Eksekusi request dengan retry
//   async executeRequestWithRetry(request) {
//     console.log(`🚀 Executing request ${request.id}: ${request.servoCommand}`);

//     const commandId = request.id;

//     // Set command dengan atomic operation
//     await db.ref("checkCameraMoveCommand").transaction((current) => {
//       // Only set if not busy
//       if (!current || current.status === 0) {
//         return {
//           commandId: commandId,
//           moveServo: request.servoCommand,
//           status: 1,
//           timestamp: Date.now(),
//           purpose: request.purpose
//         };
//       }
//       return undefined; // Abort transaction
//     });

//     try {
//       const result = await this.waitForCompletion(commandId);

//       // Clean up
//       await db.ref("checkCameraMoveCommand").set({
//         commandId: null,
//         moveServo: null,
//         status: 0,
//         timestamp: null,
//         purpose: null
//       });

//       return result;

//     } catch (error) {
//       // Clean up on error
//       await db.ref("checkCameraMoveCommand").set({
//         commandId: null,
//         moveServo: null,
//         status: 0,
//         timestamp: null,
//         purpose: null
//       });
//       throw error;
//     }
//   }

//   // Tunggu completion dengan monitoring detail
//   async waitForCompletion(commandId, maxWait = 40000) {
//     const startTime = Date.now();
//     let waited = 0;
//     const interval = 1000;
//     let consecutiveErrors = 0;
//     const maxConsecutiveErrors = 5;

//     console.log(`⏳ Waiting for completion: ${commandId}`);

//     while (waited < maxWait) {
//       try {
//         const snap = await db.ref("checkCameraMoveCommand").once("value");
//         const commandData = snap.val();

//         if (!commandData || commandData.commandId !== commandId) {
//           consecutiveErrors++;
//           if (consecutiveErrors >= maxConsecutiveErrors) {
//             throw new Error("Command data consistency error");
//           }
//           await this.delay(interval);
//           waited += interval;
//           continue;
//         }

//         consecutiveErrors = 0; // Reset error counter

//         if (commandData.status === 0) {
//           console.log(`✅ Command ${commandId} completed, fetching photo...`);

//           const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan1234');

//           if (latestPhoto) {
//             // Uncomment and fix photo validation
//             const photoTime = new Date(latestPhoto.timeCreated);
//             const commandTime = new Date(startTime - 5000); // 5s tolerance

//             if (photoTime >= commandTime) {
//               console.log(`📸 Photo validated: ${latestPhoto.name}`);
//               return latestPhoto;
//             } else {
//               console.log(`⚠️  Photo too old, waiting for newer one...`);
//             }
//           }
//         }

//       } catch (error) {
//         consecutiveErrors++;
//         console.error(`Error monitoring ${commandId}:`, error.message);

//         if (consecutiveErrors >= maxConsecutiveErrors) {
//           throw new Error(`Too many consecutive errors: ${error.message}`);
//         }
//       }

//       await this.delay(interval);
//       waited += interval;
//     }

//     throw new Error(`Timeout: Command ${commandId} not completed in ${maxWait}ms`);
//   }

//   delay(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms));
//   }

//   // Enhanced status with more details
//   getStatus() {
//     return {
//       queueLength: this.queue.length,
//       processing: this.processing,
//       locked: this.lock,
//       currentRequestId: this.currentRequestId,
//       queuedRequests: this.queue.map(req => ({
//         id: req.id,
//         servoCommand: req.servoCommand,
//         purpose: req.purpose,
//         attempts: req.attempts,
//         maxAttempts: req.maxAttempts,
//         timestamp: req.timestamp,
//         waitTime: Date.now() - req.timestamp
//       }))
//     };
//   }

//   // Clear queue (emergency)
//   clearQueue() {
//     const rejectedCount = this.queue.length;
//     this.queue.forEach(req => {
//       req.reject(new Error("Queue cleared by admin"));
//     });
//     this.queue = [];
//     this.lock = false;
//     console.log(`🧹 Queue cleared: ${rejectedCount} requests canceled`);
//     return rejectedCount;
//   }
// }

// // ============= SINGLETON INSTANCE =============
// const cameraQueue = new CameraFeedingQueue();

// // ============= PUBLIC API =============
// async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
//   console.log(`New camera request: ${servoCommand}, purpose: ${purpose}`);
//   return await cameraQueue.addRequest(servoCommand, purpose);
// }

// // Admin functions
// function getQueueStatus() {
//   return cameraQueue.getStatus();
// }

// function clearQueue() {
//   return cameraQueue.clearQueue();
// }
// module.exports = { 
//   triggerCameraAndWait,
//   getQueueStatus,
//   clearQueue
//  };
const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("./uploadFishFood");

// ============= QUEUE SYSTEM =============
class CameraFeedingQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.currentRequestId = null;
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
        timestamp: Date.now()
      };

      this.queue.push(request);
      console.log(`Request ${requestId} ditambahkan ke antrian. Queue length: ${this.queue.length}`);

      // Mulai pemrosesan jika belum jalan
      this.processQueue();
    });
  }

  // Proses antrian satu per satu
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      this.currentRequestId = request.id;
      
      console.log(`Memproses request ${request.id} - Servo: ${request.servoCommand}`);
      
      try {
        // Cek apakah ESP32 sedang sibuk
        const busyCheck = await this.checkESP32Status();
        if (busyCheck.isBusy) {
          throw new Error(`ESP32 sedang sibuk: ${busyCheck.reason}`);
        }

        // Eksekusi request
        const result = await this.executeRequest(request);
        request.resolve(result);
        
        console.log(`Request ${request.id} berhasil diproses`);
        
      } catch (error) {
        console.error(`Request ${request.id} gagal:`, error.message);
        request.reject(error);
      }
      
      // Delay antar request untuk mencegah overload
      await this.delay(2000);
    }
    
    this.processing = false;
    this.currentRequestId = null;
    console.log("Semua request dalam antrian selesai diproses");
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

      // // Cek heartbeat ESP32 (dalam 30 detik terakhir)
      // const heartbeatSnap = await db.ref("deviceStatus/esp32_last_seen").once("value");
      // const lastSeen = heartbeatSnap.val();
      
      // if (!lastSeen || (Date.now()/1000 - lastSeen) > 30) {
      //   return { isBusy: true, reason: "ESP32 tidak responsif" };
      // }

      return { isBusy: false };
    } catch (error) {
      return { isBusy: true, reason: `Error checking status: ${error.message}` };
    }
  }


  // Eksekusi request individual dengan timeout dan retry
  async executeRequest(request, maxRetries = 2) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Request ${request.id} - Percobaan ${attempt}/${maxRetries}`);

        // 1. Kirim perintah dengan timestamp unik
        const commandId = request.id;
        await db.ref("checkCameraMoveCommand").set({
          commandId: commandId,
          moveServo: request.servoCommand,
          status: 1,
          timestamp: Date.now(),
          purpose: request.purpose // Tambahkan purpose ke database
        });

        console.log(`Command sent for ${request.id}: ${request.servoCommand}, purpose: ${request.purpose}`);

        // 2. Tunggu sampai selesai dengan monitoring
        const result = await this.waitForCompletion(commandId);

        // 3. Bersihkan command
        await db.ref("checkCameraMoveCommand").set({
          commandId: null,
          moveServo: null,
          status: 0,
          timestamp: null,
          purpose: null
        });

        return result;

      } catch (error) {
        lastError = error;
        console.error(`Request ${request.id} attempt ${attempt} failed:`, error.message);

        if (attempt < maxRetries) {
          console.log(`Retry dalam 3 detik...`);
          await this.delay(3000);
        }
      }
    }

    throw lastError;
  }


  // Tunggu completion dengan monitoring detail
  async waitForCompletion(commandId, maxWait = 35000) {
    const startTime = Date.now();
    let waited = 0;
    const interval = 1000;
    let lastStatus = null;
    
    console.log(`Menunggu completion untuk command ${commandId}...`);

    while (waited < maxWait) {
      try {
        // 1. Cek status command
        const snap = await db.ref("checkCameraMoveCommand").once("value");
        const commandData = snap.val();
        
        if (!commandData) {
          throw new Error("Command data hilang dari database");
        }

        // Pastikan ini command kita
        if (commandData.commandId !== commandId) {
          throw new Error(`Command ID mismatch. Expected: ${commandId}, Got: ${commandData.commandId}`);
        }

        const currentStatus = commandData.status;
        
        // Log perubahan status
        if (currentStatus !== lastStatus) {
          console.log(`Command ${commandId} status: ${lastStatus} -> ${currentStatus}`);
          lastStatus = currentStatus;
        }

        // 2. Jika status = 0, berarti ESP32 sudah selesai
        if (currentStatus === 0) {
          console.log(`Command ${commandId} completed. Checking for photo...`);
          
          // 3. Cek foto terbaru
          const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
          
          if (latestPhoto) {
            // Validasi foto (harus baru)
            const photoTime = new Date(latestPhoto.timeCreated);
            const commandTime = new Date(startTime);
            

            console.log(`Photo validated for command ${commandId}: ${latestPhoto.name}`);
            return latestPhoto;
        
            // else {
            //   console.log(`Photo too old for command ${commandId}. Waiting for newer photo...`);
            // }
          }
        }

        // 4. Cek status ESP32
        const deviceSnap = await db.ref("deviceStatus").once("value");
        const deviceStatus = deviceSnap.val();
        
        if (deviceStatus && deviceStatus.camera_busy === "false") {
          // ESP32 bilang tidak busy tapi status masih 1? Ada masalah
          if (currentStatus === 1 && waited > 10000) {
            console.log(`Status inconsistency detected for ${commandId}. ESP32 not busy but command still pending.`);
          }
        }

      } catch (error) {
        console.error(`Error monitoring command ${commandId}:`, error.message);
      }

      await this.delay(interval);
      waited += interval;
    }

    throw new Error(`Timeout waiting for command ${commandId} completion after ${maxWait}ms`);
  }

  // Utility delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get queue status
  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentRequestId: this.currentRequestId,
      queuedRequests: this.queue.map(req => ({
        id: req.id,
        servoCommand: req.servoCommand,
        timestamp: req.timestamp
      }))
    };
  }

  // Clear queue (emergency)
  clearQueue() {
    const rejectedCount = this.queue.length;
    this.queue.forEach(req => {
      req.reject(new Error("Queue cleared by admin"));
    });
    this.queue = [];
    console.log(`Queue cleared. ${rejectedCount} requests rejected.`);
    return rejectedCount;
  }
}

// ============= SINGLETON INSTANCE =============
const cameraQueue = new CameraFeedingQueue();

// ============= PUBLIC API =============
async function triggerCameraAndWait(servoCommand, purpose = "makanan") {
  console.log(`New camera request: ${servoCommand}, purpose: ${purpose}`);
  return await cameraQueue.addRequest(servoCommand, purpose);
}

// Admin functions
function getQueueStatus() {
  return cameraQueue.getStatus();
}

function clearQueue() {
  return cameraQueue.clearQueue();
}

// ============= EXPORTS =============
module.exports = { 
  triggerCameraAndWait,
  getQueueStatus,
  clearQueue
};


// ============= OPTIONAL: Express Routes untuk Monitoring =============
/*
// Tambahkan ke express app untuk monitoring
app.get('/api/camera-queue/status', (req, res) => {
  res.json(getQueueStatus());
});

app.post('/api/camera-queue/clear', (req, res) => {
  const cleared = clearQueue();
  res.json({ message: `${cleared} requests cleared` });
});
*/