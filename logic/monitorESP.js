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
  let wasDown = false; // Tambahan: status sebelumnya

  setInterval(async () => {
    try {
      const snapshot = await db.ref("deviceStatus/esp32_last_seen").once("value");
      const lastSeenNow = snapshot.val();

      // Cek setiap menit
      if (lastSeenPrev !== null && notifEsp32Down) {
        if (lastSeenNow === lastSeenPrev) {
          // ESP32 kemungkinan down
          const now = Date.now();
          if (now - lastNotifTime > 30 * 60 * 1000) {
            await sendTelegramMessage(
              "⚠️ ESP32 kemungkinan down! Nilai esp32_last_seen tidak berubah.\n\nKetik /espnotif off untuk mematikan notifikasi ini."
            );
            lastNotifTime = now;
          }
          wasDown = true;
        } else {
          // ESP32 reconnect (ada perubahan setelah sebelumnya down)
          if (wasDown) {
            await sendTelegramMessage("✅ ESP32 sudah nyala kembali dan terhubung ke server.");
            wasDown = false;
            lastNotifTime = 0; // Reset agar notifikasi down berikutnya tidak tertunda
          }
        }
      }

      lastSeenPrev = lastSeenNow;
    } catch (err) {
      console.error("Gagal cek status ESP32:", err);
    }
  }, 60 * 1000); // setiap 1 menit
}

module.exports = { startEsp32StatusMonitor, setEsp32NotifStatus, getEsp32NotifStatus };