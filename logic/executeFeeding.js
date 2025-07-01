const readline = require("readline");
const { db } = require("../config/firebase");
const { sendTelegramMessage, askUserTelegramFood } = require("../telegram/telegramUtils");
const { askUserTerminalFood } = require("./mlSimulation");
const { processImage } = require("./machineLearning");
const { getLatestPhotoFromGCS } = require("./uploadFishFood");
const { checkFoodCapacity } = require("./checkFoodCapacity");
const { triggerCameraAndWait } = require("./triggerCamAndAwait");

async function executeFeeding(kolam, jadwalKey, sudahFeedingTambahan = false) {
  let servoCommand;
  let kotakPakan;

  switch (kolam) {
    case "kolam1":
      motorKey = "motorA";
      servoCommand = "170,140";
      kotakPakan = "A";
      break;
    case "kolam2":
      motorKey = "motorB";
      servoCommand = "35,150";
      kotakPakan = "B";
      break;
    default:
      return;
  }

  // Cek kapasitas pakan sebelum memberi pakan
  await checkFoodCapacity(kotakPakan);

  // Ambil semua jadwal kolam
  const snapshot = await db.ref(`feedingSchedules/${kolam}`).once("value");
  const jadwalList = snapshot.val();
  let duration = jadwalList[jadwalKey]?.duration || 4;

  // Urutkan key jadwal secara numerik
  const sortedKeys = Object.keys(jadwalList).sort((a, b) => {
    const numA = parseInt(a.replace("jadwal", ""));
    const numB = parseInt(b.replace("jadwal", ""));
    return numA - numB;
  });

  // Temukan index jadwal sekarang dan tentukan jadwal berikutnya
  const idx = sortedKeys.indexOf(jadwalKey);
  const nextJadwalKey = idx !== -1 && idx + 1 < sortedKeys.length ? sortedKeys[idx + 1] : null;

  if (nextJadwalKey && jadwalList[nextJadwalKey]) {
    console.log(`Next Jadwal Key: ${nextJadwalKey}`);
    console.log(`Jadwal Berikutnya:`, jadwalList[nextJadwalKey]);
  } else {
    console.error(`Jadwal berikutnya (${nextJadwalKey}) tidak ditemukan untuk kolam ${kolam}.`);
  }

  // Kirim perintah ke Firebase
  await db.ref("feedingActions").set({
    motorA: motorKey === "motorA" ? duration : 0,
    motorB: motorKey === "motorB" ? duration : 0
  });

  console.log(`Pakan dieksekusi untuk ${kolam} dengan durasi ${duration}s`);
  sendTelegramMessage(`Pakan dieksekusi untuk ${kolam} dengan durasi ${duration}s`);

  // Tunggu hingga motorA atau motorB dikembalikan ke 0 oleh ESP32
  await new Promise((resolve) => {
    const interval = setInterval(async () => {
      const feedingActionsSnapshot = await db.ref("feedingActions").once("value");
      const feedingActions = feedingActionsSnapshot.val();
      if (feedingActions.motorA === 0 && feedingActions.motorB === 0) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });

  console.log(`Motor untuk ${kolam} telah dikembalikan ke 0.`);
  let latestPhoto;
  try {
    latestPhoto = await triggerCameraAndWait(servoCommand);
  } catch (err) {
    console.error(`Error trigger kamera untuk ${kolam}:`, err);
  }
  let makananHabis = false;
  if (latestPhoto) {
    const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
    makananHabis = result.makananHabis;
    console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
  } else {
    console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
  }

  // Cek kapasitas pakan setelah motor kembali ke 0
  await checkFoodCapacity(kotakPakan);

  // Tambahkan jeda 15 menit sebelum proses pengecekan makanan
  setTimeout(async () => {
    let makananHabis = false;

    // Looping 15 menit sekali sebanyak 3 kali (hanya jika belum pernah feeding tambahan)
    if (!sudahFeedingTambahan) {
      for (let i = 0; i < 3; i++) {
        await sendTelegramMessage(`Menggerakkan servo untuk ${kolam} iterasi ke ${i + 1}`);
        let latestPhoto;
        try {
          latestPhoto = await triggerCameraAndWait(servoCommand);
          console.log(`[DEBUG] Selesai triggerCameraAndWait untuk ${kolam}`);
        } catch (err) {
          console.error(`Error trigger kamera untuk ${kolam}:`, err);
        }
        if (latestPhoto) {
          const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
          makananHabis = result.makananHabis;
          console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
        } else {
          console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
        }

        if (makananHabis) {
          console.log(`Makanan di kolam ${kolam} habis pada iterasi ${i + 1}.`);
          try {
            // Pemanggilan berikutnya: sudahFeedingTambahan = true
            await executeFeeding(kolam, jadwalKey, true);
          } catch (err) {
            console.error(`Gagal menjalankan executeFeeding ulang untuk ${kolam} pada ${jadwalKey}:`, err);
          }
          return; // Stop jika sudah habis
        }
        await delay(15 * 60 * 1000);
      }
    }

    await delay(5 * 60 * 1000); // Tambahkan jeda 5 menit sebelum pengecekan ulang

    // Jika setelah 3x looping makananHabis masih false, lakukan pengecekan 1 menit sekali sebanyak 4 kali
    for (let j = 0; j < 4; j++) {
      await sendTelegramMessage(`Pengecekan ulang makanan di kolam ${kolam} (interval ke-${j + 1}, tiap 1 menit)`);
      let latestPhoto;
      try {
        latestPhoto = await triggerCameraAndWait(servoCommand);
        console.log(`[DEBUG] Selesai triggerCameraAndWait untuk ${kolam}`);
      } catch (err) {
        console.error(`Error trigger kamera untuk ${kolam}:`, err);
      }
      if (latestPhoto) {
        const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
        makananHabis = result.makananHabis;
        console.log(`[DEBUG] Hasil ML (ulang): makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
      } else {
        console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
      }

      if (makananHabis) {
        // Hanya notifikasi, tidak ada feeding lagi!
        await sendTelegramMessage(`Pakan di kolam ${kolam} habis/sedikit setelah pengecekan ulang ke-${j + 1}.`);
        break; // Stop loop jika sudah habis
      }
      await delay(1 * 60 * 1000); // 1 menit
    }
  }, 15 * 60 * 1000);
}

// Fungsi untuk menambahkan jeda
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { executeFeeding };
// const readline = require("readline");
// const { db } = require("../config/firebase");
// const { moveServoAndTakePhoto } = require("./servoHandler");
// const { sendTelegramMessage,askUserTelegramFood } = require("../telegram/telegramUtils");
// const { askUserTerminalFood } = require("./mlSimulation");
// //const {Storage} = require('@google-cloud/storage');
// const { processImage } = require("./machineLearning");
// const {getLatestPhotoFromGCS} = require("./uploadFishFood");
// const {checkFoodCapacity} = require("./checkFoodCapacity");
// const { triggerCameraAndWait } = require("./triggerCamAndAwait");
// async function executeFeeding(kolam, jadwalKey, sudahFeedingTambahan = false){
//   let servoCommand;
//   let kotakPakan;

//   switch (kolam) {
//     case "kolam1":
//       motorKey = "motorA";
//       servoCommand = "170,140";
//       kotakPakan = "A";
//       break;
//     case "kolam2":
//       motorKey = "motorB";
//       servoCommand = "35,150";
//       kotakPakan = "B";
//       break;
//     default:
//       return;
//   }

//   // Cek kapasitas pakan sebelum memberi pakan
//   await checkFoodCapacity(kotakPakan);

//   // Ambil semua jadwal kolam
//   const snapshot = await db.ref(`feedingSchedules/${kolam}`).once("value");
//   const jadwalList = snapshot.val();
//   let duration = jadwalList[jadwalKey]?.duration || 4;

//   // Urutkan key jadwal secara numerik
//   const sortedKeys = Object.keys(jadwalList).sort((a, b) => {
//     const numA = parseInt(a.replace("jadwal", ""));
//     const numB = parseInt(b.replace("jadwal", ""));
//     return numA - numB;
//   });

//   // Temukan index jadwal sekarang dan tentukan jadwal berikutnya
//   const idx = sortedKeys.indexOf(jadwalKey);
//   const nextJadwalKey = idx !== -1 && idx + 1 < sortedKeys.length ? sortedKeys[idx + 1] : null;

//   if (nextJadwalKey && jadwalList[nextJadwalKey]) {
//     console.log(`Next Jadwal Key: ${nextJadwalKey}`);
//     console.log(`Jadwal Berikutnya:`, jadwalList[nextJadwalKey]);
//   } else {
//     console.error(`Jadwal berikutnya (${nextJadwalKey}) tidak ditemukan untuk kolam ${kolam}.`);
//   }

//   // Kirim perintah ke Firebase
//   await db.ref("feedingActions").set({
//     motorA: motorKey === "motorA" ? duration : 0,
//     motorB: motorKey === "motorB" ? duration : 0
//   });

//   console.log(`Pakan dieksekusi untuk ${kolam} dengan durasi ${duration}s`);
//   sendTelegramMessage(`Pakan dieksekusi untuk ${kolam} dengan durasi ${duration}s`);

//   // Tunggu hingga motorA atau motorB dikembalikan ke 0 oleh ESP32
//   await new Promise((resolve) => {
//     const interval = setInterval(async () => {
//       const feedingActionsSnapshot = await db.ref("feedingActions").once("value");
//       const feedingActions = feedingActionsSnapshot.val();
//       if (feedingActions.motorA === 0 && feedingActions.motorB === 0) {
//         clearInterval(interval);
//         resolve();
//       }
//     }, 1000);
//   });

//   console.log(`Motor untuk ${kolam} telah dikembalikan ke 0.`);
//   let latestPhoto;
// try {
//   latestPhoto = await triggerCameraAndWait(servoCommand);
// } catch (err) {
//   console.error(`Error trigger kamera untuk ${kolam}:`, err);
// }
// if (latestPhoto) {
//   const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//   makananHabis = result.makananHabis;
//   console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
// } else {
//   console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
// }
//   // await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
//   //   console.error(`Error saat menggerakkan servo untuk ${kolam}:`, err)
//   // );

//   // // mengecek sekali setelah memberi pakan
//   // const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
//   // if (latestPhoto) {
//   //   const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//   //   makananHabis = result.makananHabis;
//   //   console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
//   // } else {
//   //   console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
//   // }
//   // Cek kapasitas pakan setelah motor kembali ke 0
//   await checkFoodCapacity(kotakPakan);

//   // Tambahkan jeda 15 detik sebelum proses pengecekan makanan
// // ...existing code sebelum setTimeout...

// // Tambahkan jeda 15 menit sebelum proses pengecekan makanan
// setTimeout(async () => {
//     let makananHabis = false;

//     // Looping 15 menit sekali sebanyak 3 kali (hanya jika belum pernah feeding tambahan)
//     if (!sudahFeedingTambahan) {
//       for (let i = 0; i < 3; i++) {
//         await sendTelegramMessage(`Menggerakkan servo untuk ${kolam} iterasi ke ${i + 1}`);
//         await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
//           console.error(`Error pada iterasi ${i + 1}:`, err)
//         );
//         console.log(`[DEBUG] Selesai moveServoAndTakePhoto untuk ${kolam}`);

//         const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
//         if (latestPhoto) {
//           const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//           makananHabis = result.makananHabis;
//           console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
//         } else {
//           console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
//         }

//         if (makananHabis) {
//           console.log(`Makanan di kolam ${kolam} habis pada iterasi ${i + 1}.`);
//           try {
//             // Pemanggilan berikutnya: sudahFeedingTambahan = true
//             await executeFeeding(kolam, jadwalKey, true);
//           } catch (err) {
//             console.error(`Gagal menjalankan executeFeeding ulang untuk ${kolam} pada ${jadwalKey}:`, err);
//           }
//           return; // Stop jika sudah habis
//         }
//         await delay(15 * 60 * 1000);
//       }
//     }

//     await delay(5 * 60 * 1000); // Tambahkan jeda 5 menit sebelum pengecekan ulang

//     // Jika setelah 3x looping makananHabis masih false, lakukan pengecekan 1 menit sekali sebanyak 4 kali
//     // if (!makananHabis) {
//       for (let j = 0; j < 4; j++) {
//         await sendTelegramMessage(`Pengecekan ulang makanan di kolam ${kolam} (interval ke-${j + 1}, tiap 1 menit)`);
//         await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
//           console.error(`Error pengecekan ulang ke-${j + 1}:`, err)
//         );
//         console.log(`[DEBUG] Selesai pengecekan ulang ke-${j + 1} untuk ${kolam}`);

//         const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123');
//         if (latestPhoto) {
//           const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//           makananHabis = result.makananHabis;
//           console.log(`[DEBUG] Hasil ML (ulang): makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
//         } else {
//           console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
//         }

//         if (makananHabis) {
//           // Hanya notifikasi, tidak ada feeding lagi!
//           await sendTelegramMessage(`Pakan di kolam ${kolam} habis/sedikit setelah pengecekan ulang ke-${j + 1}.`);
//           break; // Stop loop jika sudah habis
//         }
//         await delay(1 * 60 * 1000); // 1 menit
//       }
//     //}
//   }, 15 * 60 * 1000);
// }


// // Fungsi untuk menambahkan jeda
// function delay(ms) {
//   return new Promise((resolve) => setTimeout(resolve, ms));
// }

// module.exports = { executeFeeding };