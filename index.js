// Struktur proyek baru untuk sistem IoT Pakan Ikan

// index.js (entry point utama)
const { uploadFishFoodImageToGCS } = require("./logic/uploadFishFood");
const { sendSecurityPhotoToTelegram } = require("./logic/uploadSecurity");
const express = require("express");
const { initTelegramBot, bot, chatId } = require("./telegram/botHandler");
const { startScheduler } = require("./scheduler/scheduler");
const { resetCurrentTimeAll } = require("./logic/resetCurrentTime");
const {startEsp32StatusMonitor} = require("./logic/monitorESP");
//const { checkSecurity } = require("./logic/securityCheck");
const app = express();

app.get("/", (req, res) => {
  res.send("IoT Fish Feeding Backend Running");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initTelegramBot();
  await startScheduler();
  //await checkSecurity();
  resetJadwalSetiapHari(); // panggil sekali di awal
  startEsp32StatusMonitor(); // panggil sekali di awal aplikasi

})

async function resetJadwalSetiapHari() {
  setInterval(async () => {
    const now = new Date();
    // Ambil jam dan menit UTC
    const jamUTC = now.getUTCHours();
    const menitUTC = now.getUTCMinutes();

    // Reset hanya pada jam 11:00 UTC (setara 18:00 WIB)
    if (jamUTC === 11 && menitUTC === 0) {
      await resetCurrentTimeAll(); // ganti dengan fungsi reset jadwal Anda
      console.log("Jadwal direset otomatis pada 18:00 WIB (11:00 UTC)");
    }
  }, 55 * 1000); // cek setiap menit
}
app.post("/uploadFood", express.raw({ type: "image/jpeg", limit: "5mb" }), uploadFishFoodImageToGCS);


//app.post("/uploadSecurity", express.raw({ type: "image/jpeg", limit: "5mb" }), sendSecurityPhotoToTelegram);
app.post('/sendSecurity', express.raw({ type: 'image/jpeg', limit: '5mb' }), async (req, res) => {
  try {
    await sendSecurityPhotoToTelegram(req.body, bot, chatId);
    res.status(200).json({ success: true, message: 'Foto berhasil dikirim ke Telegram.' });
  } catch (err) {
    res.status(500).send('Gagal kirim ke Telegram');
  }
});
// setInterval(() => {
//   checkSecurity();
// }, 10000);