// monitorESP.js
const { db } = require("../config/firebase");
const { sendTelegramMessage } = require("../telegram/telegramUtils");
let lastSeenPrev = null;
let notifEsp32Down = true; // default: notifikasi aktif

function setEsp32NotifStatus(status) {
  notifEsp32Down = status;
}

function getEsp32NotifStatus() {
  return notifEsp32Down;
}

function startEsp32StatusMonitor() {
  let lastNotifTime = 0;

  setInterval(async () => {
    try {
      const snapshot = await db.ref("deviceStatus/esp32_last_seen").once("value");
      const lastSeenNow = snapshot.val();

      // Cek setiap menit
      if (lastSeenPrev !== null && lastSeenNow === lastSeenPrev && notifEsp32Down) {
        const now = Date.now();
        // Kirim notifikasi maksimal 1x setiap 30 menit
        if (now - lastNotifTime > 30 * 60 * 1000) {
          await sendTelegramMessage(
            "⚠️ ESP32 kemungkinan down! Nilai esp32_last_seen tidak berubah.\n\nKetik /espnotif off untuk mematikan notifikasi ini."
          );
          lastNotifTime = now;
        }
      }

      lastSeenPrev = lastSeenNow;
    } catch (err) {
      console.error("Gagal cek status ESP32:", err);
    }
  }, 60 * 1000); // setiap 1 menit
}

module.exports = { startEsp32StatusMonitor, setEsp32NotifStatus, getEsp32NotifStatus };