const { db } = require("../config/firebase");
const { sendTelegramMessage } = require("../telegram/telegramUtils");

/**
 * Fungsi untuk menggerakkan motor pakan ikan.
 * @param {string} kolam - "kolam1" atau "kolam2"
 * @param {number} duration - Durasi dalam detik
 */
async function moveMotor(kolam, duration) {
  let motorA = 0;
  let motorB = 0;
  if (kolam === "kolam1") {
    motorA = duration;
  } else if (kolam === "kolam2") {
    motorB = duration;
  } else {
    throw new Error('Kolam harus "kolam1" atau "kolam2"');
  }

  await db.ref("feedingActions").set({
    motorA,
    motorB
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
}

module.exports = { moveMotor };