const { db } = require("../config/firebase");
const { sendTelegramMessage } = require("../telegram/telegramUtils");

let lastSeenPrev = null;

function startEsp32StatusMonitor() {
  setInterval(async () => {
    try {
      const snapshot = await db.ref("deviceStatus/esp32_last_seen").once("value");
      const lastSeenNow = snapshot.val();

      if (lastSeenPrev !== null && lastSeenNow === lastSeenPrev) {
        await sendTelegramMessage("⚠️ ESP32 kemungkinan down! Nilai esp32_last_seen tidak berubah.");
      }

      lastSeenPrev = lastSeenNow;
    } catch (err) {
      console.error("Gagal cek status ESP32:", err);
    }
  }, 30000); // setiap 30 detik
}

module.exports = { startEsp32StatusMonitor };