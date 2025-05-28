// Struktur proyek baru untuk sistem IoT Pakan Ikan

// index.js (entry point utama)
const { uploadFishFoodToLocal } = require("./logic/uploadFishFood");
const { uploadSecurityPhotoToCloudinary } = require("./logic/uploadSecurity");
const express = require("express");
const { initTelegramBot } = require("./telegram/botHandler");
const { startScheduler } = require("./scheduler/scheduler");
const { resetCurrentTimeAll } = require("./logic/resetCurrentTime");
//const { checkSecurity } = require("./logic/securityCheck");
const app = express();

app.get("/", (req, res) => {
  res.send("IoT Fish Feeding Backend Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initTelegramBot();
  await startScheduler();
  //await checkSecurity();
})

setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 18 && now.getMinutes() === 0) {
    await resetCurrentTimeAll();
    console.log("Jadwal currentTime direset ke defaultTime jam 18:00");
  }
}, 40 * 1000);
app.post("/uploadFood", express.raw({ type: "image/jpeg", limit: "5mb" }), uploadFishFoodToLocal);
app.post("/uploadSecurity", express.raw({ type: "image/jpeg", limit: "5mb" }), uploadSecurityPhotoToCloudinary);

// setInterval(() => {
//   checkSecurity();
// }, 10000);