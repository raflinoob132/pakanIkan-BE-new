// File: logic/securityCheck.js
// Deskripsi: Modul untuk memeriksa keamanan dengan sensor PIR dan menggerakkan servo kamera. Dipanggil oleh fungsi yang menyala matikan fungsi security
const { db } = require("../config/firebase");
const { moveServoAndTakePhoto } = require("./servoHandler");
const { sendTelegramMessage } = require("../telegram/telegramUtils");
let isChecking = false;

async function checkSecurity() {
  if (isChecking) {
    console.log("Proses pemeriksaan keamanan sedang berlangsung.");
    return;
  }
  isChecking = true;
try{
  const snapshot = await db.ref("JarakKeamanan").once("value");
  const sensors = snapshot.val();

  if (!sensors) {
    console.log("Tidak ada data sensor keamanan.");
    return;
  }

  const servoCommands = {
    sensor1: "170,80",
    sensor2: "10,80"
  };
  const servoCommandsSecond = {
    sensor1: "125,80",      // sudut kedua sensor1
    sensor2: "45,80"        // sudut kedua sensor2
  };
  let adaAncaman = false;

  for (const sensor in sensors) {
    const pirValue = parseInt(sensors[sensor]);
    const flagSnapshot = await db.ref(`AncamanKeamananAktif/${sensor}`).once("value");
    const flagAktif = flagSnapshot.val();

    if (pirValue === 1 && !flagAktif) {
      adaAncaman = true;
      const servoCommand = servoCommands[sensor];
      const pesan = `Ancaman terdeteksi di ${sensor} (PIR aktif). Menggerakkan servo dengan command ${servoCommand}.`;
      console.log(pesan);
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(true);

      await moveServoAndTakePhoto(servoCommand, "keamanan");
      await moveServoAndTakePhoto(servoCommandsSecond[sensor], "keamanan");

      await sendTelegramMessage(`Ancaman terdeteksi di ${sensor}. Proses pengambilan gambar dilakukan`);

      // Reset nilai PIR ke 0 setelah 20 detik
      setTimeout(async () => {
        await db.ref(`JarakKeamanan/${sensor}`).set(0);

        await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);

        console.log(`Reset sensor ${sensor} ke 0 setelah 20 detik.`);
      }, 7000);

    } else if (pirValue === 0 && flagAktif) {
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);
      console.log(`Ancaman di ${sensor} sudah pergi, flag direset.`);
      await sendTelegramMessage(`Ancaman di ${sensor} sudah pergi.`);
    }
  }

  if (!adaAncaman) {
    console.log("Tidak ada ancaman keamanan terdeteksi.");
  }
} catch (err) {
    console.error("Error saat cek keamanan:", err);
  } finally {
    isChecking = false;
  }
}
module.exports = { checkSecurity };
// const { db } = require("../config/firebase");
// const { moveServoAndTakePhoto } = require("./servoHandler");
// const { sendTelegramMessage } = require("../telegram/telegramUtils");

// class SecuritySystem {
//   constructor() {
//     this.isChecking = false;
//     this.sensorStates = new Map();
//     this.alertCooldown = new Map();
//     this.detectionHistory = new Map();
//     this.config = {
//       resetDelay: 7000,
//       cooldownPeriod: 30000, // 30 detik cooldown untuk mencegah spam
//       maxDetectionsPerMinute: 3,
//       confidenceThreshold: 2, // butuh 2 deteksi berturut-turut
//       servoReturnDelay: 2000 // delay sebelum servo kembali ke posisi default
//     };
    
//     // Konfigurasi servo untuk setiap sensor dengan multiple angles
//     this.servoConfig = {
//       sensor1: {
//         positions: [
//           { pan: 170, tilt: 80, label: "kanan-atas" },
//           { pan: 125, tilt: 80, label: "tengah-atas" },
//           //{ pan: 100, tilt: 60, label: "tengah-tengah" }
//         ],
//         defaultPosition: { pan: 90, tilt: 70 }
//       },
//       sensor2: {
//         positions: [
//           { pan: 10, tilt: 80, label: "kiri-atas" },
//           { pan: 45, tilt: 80, label: "tengah-atas" },
//           //{ pan: 70, tilt: 60, label: "tengah-tengah" }
//         ],
//         defaultPosition: { pan: 90, tilt: 70 }
//       }
//     };
//   }

//   // Sistem anti-false positive dengan deteksi berturut-turut
//   updateDetectionHistory(sensor, detected) {
//     if (!this.detectionHistory.has(sensor)) {
//       this.detectionHistory.set(sensor, []);
//     }
    
//     const history = this.detectionHistory.get(sensor);
//     const now = Date.now();
    
//     // Hapus deteksi yang lebih dari 1 menit
//     const filtered = history.filter(time => now - time < 60000);
    
//     if (detected) {
//       filtered.push(now);
//     }
    
//     this.detectionHistory.set(sensor, filtered);
//     return filtered.length;
//   }

//   // Cek apakah sensor dalam cooldown
//   isInCooldown(sensor) {
//     const lastAlert = this.alertCooldown.get(sensor);
//     if (!lastAlert) return false;
    
//     return (Date.now() - lastAlert) < this.config.cooldownPeriod;
//   }

//   // Validasi deteksi dengan confidence scoring
//   async validateDetection(sensor, pirValue) {
//     const detectionCount = this.updateDetectionHistory(sensor, pirValue === 1);
    
//     // Jika terlalu banyak deteksi dalam waktu singkat, mungkin false positive
//     if (detectionCount > this.config.maxDetectionsPerMinute) {
//       console.log(`Sensor ${sensor}: Terlalu banyak deteksi, kemungkinan false positive`);
//       return false;
//     }
    
//     // Butuh minimal 2 deteksi berturut-turut untuk konfirmasi
//     if (detectionCount < this.config.confidenceThreshold) {
//       console.log(`Sensor ${sensor}: Deteksi belum terkonfirmasi (${detectionCount}/${this.config.confidenceThreshold})`);
//       return false;
//     }
    
//     return true;
//   }

//   // Sweep kamera dengan multiple angles
//   async performCameraSweep(sensor) {
//     const config = this.servoConfig[sensor];
//     if (!config) return;

//     console.log(`Memulai camera sweep untuk ${sensor}`);
    
//     try {
//       for (let i = 0; i < config.positions.length; i++) {
//         const pos = config.positions[i];
//         const servoCommand = `${pos.pan},${pos.tilt}`;
        
//         console.log(`${sensor}: Mengambil foto dari posisi ${pos.label} (${servoCommand})`);
//         await moveServoAndTakePhoto(servoCommand, `keamanan_${sensor}_${pos.label}`);
        
//         // Delay antar posisi untuk stabilitas
//         if (i < config.positions.length - 1) {
//           await this.delay(1000);
//         }
//       }
      
//       // Kembali ke posisi default setelah sweep
//       setTimeout(async () => {
//         // const defaultCmd = `${config.defaultPosition.pan},${config.defaultPosition.tilt}`;
//         // await moveServoAndTakePhoto(defaultCmd, "reset_position");
//       }, this.config.servoReturnDelay);
      
//     } catch (error) {
//       console.error(`Error saat camera sweep ${sensor}:`, error);
//     }
//   }

//   // Sistem logging yang lebih detail
//   async logSecurityEvent(sensor, eventType, details = {}) {
//     const timestamp = new Date().toISOString();
//     const logData = {
//       timestamp,
//       sensor,
//       eventType,
//       ...details
//     };
    
//     try {
//       await db.ref(`SecurityLogs/${sensor}/${Date.now()}`).set(logData);
//       console.log(`Log keamanan: ${JSON.stringify(logData)}`);
//     } catch (error) {
//       console.error("Error saat logging:", error);
//     }
//   }

//   // Delay helper
//   delay(ms) {
//     return new Promise(resolve => setTimeout(resolve, ms));
//   }

//   // Fungsi utama pemeriksaan keamanan
//   async checkSecurity() {
//     if (this.isChecking) {
//       console.log("Proses pemeriksaan keamanan sedang berlangsung.");
//       return;
//     }
    
//     this.isChecking = true;
    
//     try {
//       const snapshot = await db.ref("JarakKeamanan").once("value");
//       const sensors = snapshot.val();

//       if (!sensors) {
//         console.log("Tidak ada data sensor keamanan.");
//         return;
//       }

//       let adaAncaman = false;

//       for (const sensor in sensors) {
//         const pirValue = parseInt(sensors[sensor]);
//         const flagSnapshot = await db.ref(`AncamanKeamananAktif/${sensor}`).once("value");
//         const flagAktif = flagSnapshot.val();

//         // Ancaman baru terdeteksi
//         if (pirValue === 1 && !flagAktif) {
//           // Validasi deteksi untuk mengurangi false positive
//           const isValidDetection = await this.validateDetection(sensor, pirValue);
          
//           if (!isValidDetection) {
//             continue;
//           }
          
//           // Cek cooldown untuk mencegah spam alert
//           if (this.isInCooldown(sensor)) {
//             console.log(`Sensor ${sensor} masih dalam cooldown period`);
//             continue;
//           }

//           adaAncaman = true;
//           console.log(`ANCAMAN TERDETEKSI: ${sensor} (PIR aktif dengan validasi)`);
          
//           // Set flag ancaman aktif
//           await db.ref(`AncamanKeamananAktif/${sensor}`).set(true);
          
//           // Log event
//           await this.logSecurityEvent(sensor, "THREAT_DETECTED", {
//             pirValue,
//             validationPassed: true
//           });
          
//           // Lakukan camera sweep
//           await this.performCameraSweep(sensor);
          
//           // Kirim notifikasi Telegram dengan info lebih detail
//           const detectionCount = this.detectionHistory.get(sensor)?.length || 0;
//           await sendTelegramMessage(
//             `🚨 ANCAMAN TERDETEKSI!\n` +
//             `📍 Lokasi: ${sensor}\n` +
//             `🔍 Confidence: ${detectionCount}/${this.config.confidenceThreshold}\n` +
//             `📸 Camera sweep sedang dilakukan\n` +
//             `⏰ ${new Date().toLocaleString('id-ID')}`
//           );

//           // Set cooldown
//           this.alertCooldown.set(sensor, Date.now());

//           // Reset sensor dengan delay
//           setTimeout(async () => {
//             try {
//               await db.ref(`JarakKeamanan/${sensor}`).set(0);
//               await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);
              
//               await this.logSecurityEvent(sensor, "SENSOR_RESET");
//               console.log(`Reset sensor ${sensor} setelah ${this.config.resetDelay}ms`);
//             } catch (error) {
//               console.error(`Error reset ${sensor}:`, error);
//             }
//           }, this.config.resetDelay);

//         } 
//         // Ancaman sudah pergi
//         else if (pirValue === 0 && flagAktif) {
//           await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);
          
//           await this.logSecurityEvent(sensor, "THREAT_CLEARED");
//           console.log(`Ancaman di ${sensor} sudah pergi, flag direset.`);
          
//           await sendTelegramMessage(
//             `✅ Area ${sensor} sudah aman\n` +
//             `⏰ ${new Date().toLocaleString('id-ID')}`
//           );
          
//           // Clear detection history untuk sensor ini
//           this.detectionHistory.delete(sensor);
//         }
//       }

//       if (!adaAncaman) {
//         console.log("Tidak ada ancaman keamanan terdeteksi.");
//       }

//     } catch (err) {
//       console.error("Error saat cek keamanan:", err);
      
//       // Log error ke Firebase
//       try {
//         await db.ref(`SystemErrors/${Date.now()}`).set({
//           timestamp: new Date().toISOString(),
//           error: err.message,
//           stack: err.stack
//         });
//       } catch (logError) {
//         console.error("Error saat logging error:", logError);
//       }
      
//     } finally {
//       this.isChecking = false;
//     }
//   }

//   // Method untuk mengatur konfigurasi secara dinamis
//   updateConfig(newConfig) {
//     this.config = { ...this.config, ...newConfig };
//     console.log("Konfigurasi sistem keamanan diperbarui:", this.config);
//   }

//   // Method untuk mendapatkan status sistem
//   getSystemStatus() {
//     return {
//       isChecking: this.isChecking,
//       activeSensors: Array.from(this.sensorStates.keys()),
//       cooldownSensors: Array.from(this.alertCooldown.keys()),
//       detectionHistory: Object.fromEntries(this.detectionHistory),
//       config: this.config
//     };
//   }
// }

// // Inisialisasi sistem
// const securitySystem = new SecuritySystem();

// // Export fungsi utama dan sistem
// module.exports = { 
//   checkSecurity: () => securitySystem.checkSecurity(),
//   securitySystem // Export sistem untuk konfigurasi lanjutan
// };