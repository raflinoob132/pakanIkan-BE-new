const readline = require("readline");
const { db } = require("../config/firebase");
const { moveServoAndTakePhoto } = require("./servoHandler");
const { sendTelegramMessage,askUserTelegramFood } = require("../telegram/telegramUtils");
const { askUserTerminalFood } = require("./mlSimulation");
//const {Storage} = require('@google-cloud/storage');
const { processImage } = require("./machineLearning");
const {getLatestPhotoFromGCS} = require("./uploadFishFood");
async function executeFeeding(kolam, jadwalKey) {
  let motorKey;
  let servoCommand;

  switch (kolam) {
    case "kolam1":
      motorKey = "motorA";
      servoCommand = "0,20";
      break;
    case "kolam2":
      motorKey = "motorB";
      servoCommand = "180,20";
      break;
    default:
      return;
  }

  // Ambil semua jadwal kolam
  const snapshot = await db.ref(`feedingSchedules/${kolam}`).once("value");
  const jadwalList = snapshot.val();
  let duration = jadwalList[jadwalKey]?.duration || 5;

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

  // Tambahkan jeda 15 detik sebelum proses pengecekan makanan
  setTimeout(async () => {
    let makananHabis = false;

    for (let i = 0; i < 3; i++) {
      await sendTelegramMessage(`Menggerakkan servo untuk ${kolam} iterasi ke ${i + 1}`);
      await moveServoAndTakePhoto(/*kolam,*/ servoCommand, "makanan").catch((err) =>
        console.error(`Error pada iterasi ${i + 1}:`, err)
      );
      console.log(`[DEBUG] Selesai moveServoAndTakePhoto untuk ${kolam}`);

const latestPhoto = await getLatestPhotoFromGCS('pakan-ikan123'); // ganti dengan nama bucket kamu
  let makananHabis = false;
  if (latestPhoto) {
    // Proses gambar dengan ML
    const result = await processImage(latestPhoto.buffer, latestPhoto.fileName);
    makananHabis = result.makananHabis;
    console.log(`[DEBUG] Hasil ML: makananHabis = ${makananHabis}, count = ${result.detectedFishFoodCount}`);
  } else {
    console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengecekan ML.');
  }

  if (makananHabis) {
    console.log(`Makanan di kolam ${kolam} habis pada iterasi ${i + 1}.`);
    try {
      await executeFeeding(kolam, jadwalKey);
    } catch (err) {
      console.error(`Gagal menjalankan executeFeeding ulang untuk ${kolam} pada ${jadwalKey}:`, err);
    }
    break;
  }
  await delay(20000);
}

    // if (!makananHabis && nextJadwalKey && jadwalList[nextJadwalKey]) {
    //   await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/duration`).set(0);
    //   await db.ref(`feedingSchedules/${kolam}/${nextJadwalKey}/doneToday`).set(true);

    //   console.log(`Pemberian pakan untuk ${kolam} pada ${nextJadwalKey} tidak akan diberikan.`);
    // }
  }, 15000);
}



// Fungsi untuk menambahkan jeda
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { executeFeeding };