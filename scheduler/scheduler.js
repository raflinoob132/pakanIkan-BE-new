const { getSchedule, setSchedule } = require("../logic/scheduleFunctions");
const { executeFeeding } = require("../logic/executeFeeding");
const { askUserTelegramFood, sendTelegramMessage } = require("../telegram/telegramUtils");
const { moveServoAndTakePhoto } = require("../logic/servoHandler");
const { admin, db } = require("../config/firebase");

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
          // Tentukan parameter servoCommand sesuai kolam
          let servoCommand = "";
          if (kolam === "kolam1") {
            servoCommand = "0,20";
          } else if (kolam === "kolam2") {
            servoCommand = "0,100";
          }
          // Panggil moveServoAndTakePhoto sebelum tanya user
          if (servoCommand) {
            await moveServoAndTakePhoto(servoCommand, "makanan").catch((err) =>
              console.error(`Gagal menjalankan moveServoAndTakePhoto untuk ${kolam}:`, err)
            );
          }

          // Tanya user dulu sebagai dummy dari machine learning
          const makananHabis = await askUserTelegramFood(`Apakah makanan di kolam ${kolam} sudah habis ? (y/n): `);
          if (makananHabis) {
            await executeFeeding(kolam, key);
            schedules[kolam][key].doneToday = true;
            await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).set(true);
            // Kirim pesan ke Telegram jika feeding berhasil
            await sendTelegramMessage(`Feeding berhasil dilakukan untuk ${kolam} pada jadwal ${key} (${currentTime})`);
          } else {
            // Tambah 5 menit dari jadwal sekarang
            const [jam, menit] = currentTime.split(":").map(Number);
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), jam, menit + 5);
            const newTime = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
            await setSchedule(kolam, key, newTime, false);

            // Cek jadwal berikutnya
            const nextJadwalKey = jadwalKeys[i + 1];
            const nextJadwal = nextJadwalKey ? schedules[kolam][nextJadwalKey] : null;
            if (nextJadwal && nextJadwal.defaultTime) {
              if (newTime >= nextJadwal.defaultTime) {
                await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);
                const msg = `Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${newTime}) > defaultTime jadwal berikutnya (${nextJadwal.defaultTime})`;
                console.log(msg);
                // Kirim pesan ke Telegram jika jadwal berikutnya dilewati
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