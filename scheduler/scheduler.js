const { getSchedule, setSchedule } = require("../logic/scheduleFunctions");
const { executeFeeding } = require("../logic/executeFeeding");
const { sendTelegramMessage } = require("../telegram/telegramUtils");
const { triggerCameraAndWait } = require("../logic/triggerCamAndAwait"); // Ganti import ini
const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("../logic/uploadFishFood");
const { processImage } = require("../logic/machineLearning");

function add7Hours(timeStr) {
  // timeStr: "HH:mm"
  const [hour, minute] = timeStr.split(":").map(Number);
  let date = new Date(2000, 0, 1, hour, minute); // tanggal dummy
  date.setHours(date.getHours() + 7);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
async function startScheduler() {
  setInterval(async () => {
    const schedules = await getSchedule();
    const now = new Date();
    const timeHM = now.toTimeString().slice(0, 5);

    for (const kolam in schedules) {
      const jadwalKeys = Object.keys(schedules[kolam]);
      for (let i = 0; i < jadwalKeys.length; i++) {
        const key = jadwalKeys[i];
        const { currentTime, doneToday } = schedules[kolam][key];
        
        if (currentTime === timeHM && !doneToday) {
          // ✅ DOUBLE-CHECK: Re-verify from database to prevent race conditions
          const freshSchedule = await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).once("value");
          if (freshSchedule.val() === true) {
            console.log(`Jadwal ${kolam}/${key} sudah selesai di request lain, skip.`);
            continue;
          }

          // ✅ ATOMIC UPDATE: Mark as processing to prevent duplicate execution
          try {
            await db.ref(`feedingSchedules/${kolam}/${key}/processing`).set(true);
          } catch (err) {
            console.log(`Gagal set processing flag untuk ${kolam}/${key}:`, err);
            continue;
          }

          sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} telah tiba (${add7Hours(currentTime)}), memulai pengecekan pakan di kolam...`);
          
          // Tentukan parameter servoCommand sesuai kolam
          let servoCommand = "";
          if (kolam === "kolam1") {
            servoCommand = "170,140";
          } else if (kolam === "kolam2") {
            servoCommand = "35,140";
          }
          
          // Ganti moveServoAndTakePhoto dengan triggerCameraAndWait
          let latestPhoto = null;
          if (servoCommand) {
            try {
              latestPhoto = await triggerCameraAndWait(servoCommand);
              console.log(`[DEBUG] Selesai triggerCameraAndWait untuk ${kolam}`);
            } catch (err) {
              console.error(`Gagal triggerCameraAndWait untuk ${kolam}:`, err);
              // ✅ CLEANUP: Reset processing flag on error
              await db.ref(`feedingSchedules/${kolam}/${key}/processing`).set(false);
              continue;
            }
          }

          // --- Cek pakan habis dengan ML ---
          let makananHabis = false;
          if (latestPhoto) {
            const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
            makananHabis = result.makananHabis;
            console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
          } else {
            console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
          }

          if (makananHabis) {
            await executeFeeding(kolam, key);
            
            // ✅ ATOMIC COMPLETION: Update both flags together
            await db.ref(`feedingSchedules/${kolam}/${key}`).update({
              doneToday: true,
              processing: false
            });
            
            await sendTelegramMessage(`Feeding berhasil dilakukan untuk ${kolam} pada jadwal ${key} (${add7Hours(currentTime)})`);
          } else {
            // Tambah 5 menit dari jadwal sekarang
            const [jam, menit] = currentTime.split(":").map(Number);
            const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), jam, menit));
            date.setUTCMinutes(date.getUTCMinutes() + 5);
            const newTime = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
            
            await setSchedule(kolam, key, newTime, false);
            
            // ✅ RESET: Clear processing flag
            await db.ref(`feedingSchedules/${kolam}/${key}/processing`).set(false);
            
            await sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} diubah ke (${add7Hours(newTime)}) karena makanan belum habis.`);

            // Cek jadwal berikutnya
            const nextJadwalKey = jadwalKeys[i + 1];
            const nextJadwal = nextJadwalKey ? schedules[kolam][nextJadwalKey] : null;
            if (nextJadwal && nextJadwal.defaultTime) {
              const toMinutes = (str) => {
                const [h, m] = str.split(":").map(Number);
                return h * 60 + m;
              };
              if (toMinutes(newTime) >= toMinutes(nextJadwal.defaultTime)) {
                await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);
                const msg = `Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${add7Hours(newTime)}) >= defaultTime jadwal berikutnya (${add7Hours(nextJadwal.defaultTime)})`;
                console.log(msg);
                await sendTelegramMessage(msg);
              }
            }
          }
        }
      }
    }
  }, 60 * 1000); // setiap 1 menit
}
// async function startScheduler() {
//   setInterval(async () => {
//     const schedules = await getSchedule();
//     const now = new Date();
//     const timeHM = now.toTimeString().slice(0, 5);

//     for (const kolam in schedules) {
//       const jadwalKeys = Object.keys(schedules[kolam]);
//       for (let i = 0; i < jadwalKeys.length; i++) {
//         const key = jadwalKeys[i];
//         const { currentTime, doneToday } = schedules[kolam][key];
//         if (currentTime === timeHM && !doneToday) {
//           sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} telah tiba (${add7Hours(currentTime)}), memulai pengecekan pakan di kolam...`);
//           // Tentukan parameter servoCommand sesuai kolam
//           let servoCommand = "";
//           if (kolam === "kolam1") {
//             servoCommand = "170,140";
//           } else if (kolam === "kolam2") {
//             servoCommand = "35,140";
//           }
//           // Ganti moveServoAndTakePhoto dengan triggerCameraAndWait
//           let latestPhoto = null;
//           if (servoCommand) {
//             try {
//               latestPhoto = await triggerCameraAndWait(servoCommand);
//               console.log(`[DEBUG] Selesai triggerCameraAndWait untuk ${kolam}`);
//             } catch (err) {
//               console.error(`Gagal triggerCameraAndWait untuk ${kolam}:`, err);
//             }
//           }

//           // --- Cek pakan habis dengan ML ---
//           let makananHabis = false;
//           if (latestPhoto) {
//             const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//             makananHabis = result.makananHabis;
//             console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
//           } else {
//             console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
//           }

//           if (makananHabis) {
//             await executeFeeding(kolam, key);
//             schedules[kolam][key].doneToday = true;
//             await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).set(true);
//             await sendTelegramMessage(`Feeding berhasil dilakukan untuk ${kolam} pada jadwal ${key} (${add7Hours(currentTime)})`);
//           } else {
//             // Tambah 5 menit dari jadwal sekarang
//             const [jam, menit] = currentTime.split(":").map(Number);
//             // Buat objek Date UTC
//             const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), jam, menit));
//             date.setUTCMinutes(date.getUTCMinutes() + 5);
//             // Ambil jam dan menit hasil penambahan (masih UTC)
//             const newTime = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
//             await setSchedule(kolam, key, newTime, false);
//             await sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} diubah ke (${add7Hours(newTime)}) karena makanan belum habis.`);

//             // Cek jadwal berikutnya
//             const nextJadwalKey = jadwalKeys[i + 1];
//             const nextJadwal = nextJadwalKey ? schedules[kolam][nextJadwalKey] : null;
//             if (nextJadwal && nextJadwal.defaultTime) {
//               const toMinutes = (str) => {
//                 const [h, m] = str.split(":").map(Number);
//                 return h * 60 + m;
//               };
//               if (toMinutes(newTime) >= toMinutes(nextJadwal.defaultTime)) {
//                 await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);
//                 const msg = `Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${add7Hours(newTime)}) >= defaultTime jadwal berikutnya (${add7Hours(nextJadwal.defaultTime)})`;
//                 console.log(msg);
//                 await sendTelegramMessage(msg);
//               }
//             }
//           }
//         }
//       }
//     }
//   }, 60 * 1000); // setiap 1 menit
// }

module.exports = { startScheduler };
// const { getSchedule, setSchedule } = require("../logic/scheduleFunctions");
// const { executeFeeding } = require("../logic/executeFeeding");
// const { sendTelegramMessage } = require("../telegram/telegramUtils");
// const { moveServoAndTakePhoto } = require("../logic/servoHandler");
// const { db } = require("../config/firebase");
// const { getLatestPhotoFromGCS } = require("../logic/uploadFishFood");
// const { processImage } = require("../logic/machineLearning");

// function add7Hours(timeStr) {
//   // timeStr: "HH:mm"
//   const [hour, minute] = timeStr.split(":").map(Number);
//   let date = new Date(2000, 0, 1, hour, minute); // tanggal dummy
//   date.setHours(date.getHours() + 7);
//   const h = String(date.getHours()).padStart(2, "0");
//   const m = String(date.getMinutes()).padStart(2, "0");
//   return `${h}:${m}`;
// }

// async function startScheduler() {
//   setInterval(async () => {
//     const schedules = await getSchedule();
//     const now = new Date();
//     const timeHM = now.toTimeString().slice(0, 5);

//     for (const kolam in schedules) {
//       const jadwalKeys = Object.keys(schedules[kolam]);
//       for (let i = 0; i < jadwalKeys.length; i++) {
//         const key = jadwalKeys[i];
//         const { currentTime, doneToday } = schedules[kolam][key];
//         if (currentTime === timeHM && !doneToday) {
//           sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} telah tiba (${add7Hours(currentTime)}), memulai pengecekan pakan di kolam...`);
//           // Tentukan parameter servoCommand sesuai kolam
//           let servoCommand = "";
//           if (kolam === "kolam1") {
//             servoCommand = "170,140";
//           } else if (kolam === "kolam2") {
//             servoCommand = "35,150";
//           }
//           // Panggil moveServoAndTakePhoto sebelum cek ML
//           if (servoCommand) {
//             await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
//               console.error(`Gagal menjalankan moveServoAndTakePhoto untuk ${kolam}:`, err)
//             );
//           }
//           console.log(`[DEBUG] Selesai moveServoAndTakePhoto untuk ${kolam}`);

//           // --- Cek pakan habis dengan ML ---
//           let makananHabis = false;
//           const latestPhoto = await getLatestPhotoFromGCS();
//           if (latestPhoto) {
//             const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
//             makananHabis = result.makananHabis;
//             console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
//           } else {
//             console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
//           }

//           if (makananHabis) {
//             await executeFeeding(kolam, key);
//             schedules[kolam][key].doneToday = true;
//             await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).set(true);
//             await sendTelegramMessage(`Feeding berhasil dilakukan untuk ${kolam} pada jadwal ${key} (${add7Hours(currentTime)})`);
//           } else {
//             // Tambah 5 menit dari jadwal sekarang
//              const [jam, menit] = currentTime.split(":").map(Number);
//             // Buat objek Date UTC
//             const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), jam, menit));
//             date.setUTCMinutes(date.getUTCMinutes() + 5);
//             // Ambil jam dan menit hasil penambahan (masih UTC)
//             const newTime = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
//             await setSchedule(kolam, key, newTime, false);
//             await sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} diubah ke (${add7Hours(newTime)}) karena makanan belum habis.`);

//             // Cek jadwal berikutnya
//             const nextJadwalKey = jadwalKeys[i + 1];
//             const nextJadwal = nextJadwalKey ? schedules[kolam][nextJadwalKey] : null;
//             if (nextJadwal && nextJadwal.defaultTime) {
//               const toMinutes = (str) => {
//                 const [h, m] = str.split(":").map(Number);
//                 return h * 60 + m;
//               };
//               if (toMinutes(newTime) >= toMinutes(nextJadwal.defaultTime)) {
//                 await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);
//                 const msg = `Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${add7Hours(newTime)}) >= defaultTime jadwal berikutnya (${add7Hours(nextJadwal.defaultTime)})`;
//                 console.log(msg);
//                 await sendTelegramMessage(msg);
//               }
//             }
//           }
//         }
//       }
//     }
//   }, 60 * 1000); // setiap 1 menit
// }

// module.exports = { startScheduler };