const { getSchedule, setSchedule } = require("../logic/scheduleFunctions");
const { executeFeeding } = require("../logic/executeFeeding");
const { askUserTelegramFood } = require("../telegram/telegramUtils");
const { moveServoAndTakePhoto } = require("../logic/servoHandler"); // tambahkan import ini
const { admin, db } = require("../config/firebase");

async function startScheduler() {
  setInterval(async () => {
    const schedules = await getSchedule();
    const now = new Date();
    const timeHM = now.toTimeString().slice(0, 5);

    for (const kolam in schedules) {
      for (const key in schedules[kolam]) {
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
          } else {
            // Tambah 5 menit dari jadwal sekarang
            const [jam, menit] = currentTime.split(":").map(Number);
            const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), jam, menit + 5);
            const newTime = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
            await setSchedule(kolam, key, newTime, false);
            if (nextJadwal && nextJadwal.defaultTime) {
              // Bandingkan waktu dalam format "HH:MM"
              if (newTime > nextJadwal.defaultTime) {
                // Set doneToday jadwal berikutnya menjadi true
                await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);
                console.log(`Jadwal ${nextJadwalKey} untuk ${kolam} dilewati karena currentTime jadwal sebelumnya (${newTime}) > defaultTime jadwal berikutnya (${nextJadwal.defaultTime})`);
              }
            }
          }
        }
      }
    }
  }, 60 * 1000); // setiap 1 menit
}

module.exports = { startScheduler };