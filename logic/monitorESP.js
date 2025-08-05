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
  setInterval(async () => {
    try {
      const snapshot = await db.ref("deviceStatus/esp32_last_seen").once("value");
      const lastSeenNow = snapshot.val();

      if (lastSeenPrev !== null && lastSeenNow === lastSeenPrev && notifEsp32Down) {
        await sendTelegramMessage(
          "⚠️ ESP32 kemungkinan down! Nilai esp32_last_seen tidak berubah.\n\nKetik /espnotif off untuk mematikan notifikasi ini."
        );
      }

      lastSeenPrev = lastSeenNow;
    } catch (err) {
      console.error("Gagal cek status ESP32:", err);
    }
  }, 10000); // setiap 10 detik
}

module.exports = { startEsp32StatusMonitor, setEsp32NotifStatus, getEsp32NotifStatus };