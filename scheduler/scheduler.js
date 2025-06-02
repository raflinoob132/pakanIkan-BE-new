const { getSchedule, setSchedule } = require("../logic/scheduleFunctions");
const { executeFeeding } = require("../logic/executeFeeding");
const { sendTelegramMessage } = require("../telegram/telegramUtils");
const { moveServoAndTakePhoto } = require("../logic/servoHandler");
const { db } = require("../config/firebase");
const { getLatestPhotoFromGCS } = require("../logic/uploadFishFood");
const { processImage } = require("../logic/machineLearning");

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
          sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} telah tiba (${currentTime}), memulai pengecekan pakan di kolam...`);
          // Tentukan parameter servoCommand sesuai kolam
          let servoCommand = "";
          if (kolam === "kolam1") {
            servoCommand = "0,20";
          } else if (kolam === "kolam2") {
            servoCommand = "0,100";
          }
          // Panggil moveServoAndTakePhoto sebelum cek ML
          if (servoCommand) {
            await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
              console.error(`Gagal menjalankan moveServoAndTakePhoto untuk ${kolam}:`, err)
            );
          }
          console.log(`[DEBUG] Selesai moveServoAndTakePhoto untuk ${kolam}`);

          // --- Cek pakan habis dengan ML ---
          let makananHabis = false;
          const latestPhoto = await getLatestPhotoFromGCS();
          if (latestPhoto) {
            const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
            makananHabis = result.makananHabis;
            console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
          } else {
            console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
          }

          if (makananHabis) {
            await executeFeeding(kolam, key);
            schedules[kolam][key].doneToday = true;
            await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).set(true);
            await sendTelegramMessage(`Feeding berhasil dilakukan untuk ${kolam} pada jadwal ${key} (${currentTime})`);
          } else {
            // Tambah 5 menit dari jadwal sekarang
            const [jam, menit] = currentTime.split(":").map(Number);
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), jam, menit + 5);
            const newTime = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
            await setSchedule(kolam, key, newTime, false);
            await sendTelegramMessage(`Jadwal feeding untuk ${kolam} pada ${key} diubah ke ${newTime} karena makanan belum habis.`);

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
                const msg = `Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${newTime}) >= defaultTime jadwal berikutnya (${nextJadwal.defaultTime})`;
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

module.exports = { startScheduler };