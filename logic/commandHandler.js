const { setSchedule, getSchedule,deleteSchedule } = require("./scheduleFunctions");
const { startSecurityCheck, stopSecurityCheck, securityActive } = require("../logic/securityActivation");
const { viewSchedule } = require("./viewSchedule"); // Tambahkan ini
const { checkFoodCapacity } = require("./checkFoodCapacity"); // Tambahkan ini
const { moveServoAndTakePhoto } = require("./servoHandler"); // Pastikan ini sudah ada
const { setEsp32NotifStatus, getEsp32NotifStatus } = require("./monitorESP");
const { moveMotor } = require("./movemotor"); // Tambahkan ini
const { triggerCameraAndWait } = require("./triggerCamAndAwait"); // Pastikan ini sudah ada
async function handleTelegramCommand(text, chatId, bot) {
  if (text.startsWith("/set")) {
    // Format: /set kolam1 jadwal2 08:00
    const [_, kolam, jadwalKey, time] = text.split(" ");
    if (!kolam || !jadwalKey || !time) {
      await bot.sendMessage(chatId, "Format salah. Gunakan: /set kolam1 jadwal2 08:00");
      return;
    }
    await setSchedule(kolam, jadwalKey, time, true);
    await bot.sendMessage(chatId, `Jadwal ${jadwalKey} untuk ${kolam} disimpan pada ${time}`);
   } 
  // else if (text.startsWith("/list")) {
  //   const schedules = await getSchedule();
  //   await bot.sendMessage(chatId, JSON.stringify(schedules, null, 2));
    else if (text.startsWith("/lihatjadwal")) {
    const jadwalText = await viewSchedule();
    await bot.sendMessage(chatId, jadwalText);
  } else if (text.startsWith("/security")) {
    const [, action] = text.split(" ");
    if (action === "on") {
      startSecurityCheck();
      await bot.sendMessage(chatId, "Security check diaktifkan.");
    } else if (action === "off") {
      stopSecurityCheck();
      await bot.sendMessage(chatId, "Security check dimatikan.");
    }
  } else if (text.startsWith("/hapusjadwal")) {
    // Format: /hapusjadwal kolam1 jadwal2
    const [_, kolam, jadwalKey] = text.split(" ");
    if (!kolam || !jadwalKey) {
      await bot.sendMessage(chatId, "Format salah. Gunakan: /hapusjadwal <kolam> <jadwalKey> (contoh: /hapusjadwal kolam1 jadwal2)");
      return;
    }
    try {
      await deleteSchedule(kolam, jadwalKey);
      await bot.sendMessage(chatId, `Jadwal ${jadwalKey} untuk ${kolam} berhasil dihapus.`);
    } catch (err) {
      await bot.sendMessage(chatId, `Gagal menghapus jadwal: ${err.message}`);
    }

  } else if (text.startsWith("/help")) {
    const helpMessage = `
Daftar Command:
/set <kolam> <jadwal> <jam>  - Set jadwal (contoh: /set kolam1 jadwal2 08:00)
/lihatjadwal                 - Lihat jadwal dalam format mudah dibaca
/security on                 - Aktifkan security check
/security off                - Matikan security check
/cekpakan                    - Cek kapasitas pakan (gunakan /cekpakan A atau /cekpakan B)  
/hapusjadwal <kolam> <jadwal> - Hapus jadwal (contoh: /hapusjadwal kolam1 jadwal2)
/ambilfoto <pilihan>         - Ambil foto posisi servo (pilihan: kolam1, kolam2, depan1, samping1, depan2, samping2)
/beripakan <kolam> <durasi>  - Gerakkan motor pakan (contoh: /beripakan kolam1 5)
/espnotif on|off             - Aktifkan/matikan notifikasi ESP32 down
/help                        - Lihat daftar command
`;
    await bot.sendMessage(chatId, helpMessage);
  } else if (text.startsWith("/cekpakan")) {
    const [, kotak] = text.split(" ");
    if (kotak !== "A" && kotak !== "B") {
      await bot.sendMessage(chatId, "Gunakan /cekpakan A atau /cekpakan B untuk mengecek kapasitas pakan.");
      return;
    }
    await checkFoodCapacity(kotak);
  }else if (text.startsWith("/testservo")) {
    await bot.sendMessage(chatId, "Memulai test 2x moveServoAndTakePhoto (akan antre jika lock bekerja)...");

    // Panggil dua kali berturut-turut
    moveServoAndTakePhoto("0,110", "keamanan")
      .then(() => bot.sendMessage(chatId, "moveServoAndTakePhoto pertama selesai"))
      .catch(err => bot.sendMessage(chatId, "moveServoAndTakePhoto pertama error: " + err.message));

    moveServoAndTakePhoto("180,110", "keamanan")
      .then(() => bot.sendMessage(chatId, "moveServoAndTakePhoto kedua selesai"))
      .catch(err => bot.sendMessage(chatId, "moveServoAndTakePhoto kedua error: " + err.message));

  // ...existing code...
  
  } else if (text.startsWith("/ambilfoto")) {
    // Format: /ambilfoto {pilihan}
    const [, pilihan] = text.split(" ");
    let servoCommand = null;
    let label = "";
    switch (pilihan) {
      case "kolam1":
        servoCommand = "170,140";
        label = "Kolam 1";
        break;
      case "kolam2":
        servoCommand = "35,140";
        label = "Kolam 2";
        break;
      case "depan1":
        servoCommand = "170,80";
        label = "Depan Kolam 1";
        break;
      case "samping1":
        servoCommand = "125,80";
        label = "Samping Kolam 1";
        break;
      case "depan2":
        servoCommand = "10,80";
        label = "Depan Kolam 2";
        break;
      case "samping2":
        servoCommand = "45,80";
        label = "Samping Kolam 2";
        break;
      default:
        await bot.sendMessage(chatId, "Pilihan tidak dikenal. Pilihan: kolam1, kolam2, depan1, samping1, depan2, samping2");
        return;
    }
    await bot.sendMessage(chatId, `Mengambil foto pada posisi: ${label}...`);
    let latestPhoto;
    try {
      latestPhoto = await triggerCameraAndWait(servoCommand);
      if (latestPhoto && latestPhoto.fileName) {
        const publicUrl = `https://storage.googleapis.com/pakan-ikan123/${latestPhoto.fileName}`;
        await bot.sendPhoto(chatId, publicUrl, { caption: `Foto posisi: ${label}` });
        console.log(`[DEBUG] Foto berhasil dikirim ke Telegram: ${publicUrl}`);
      } else {
        await bot.sendMessage(chatId, "Foto gagal diambil atau tidak ditemukan.");
        console.log('[DEBUG] Tidak ada foto terbaru di GCS, skip pengiriman ke Telegram.');
      }
    } catch (err) {
      await bot.sendMessage(chatId, `Gagal mengambil foto: ${err.message}`);
      console.error(`[DEBUG] Error triggerCameraAndWait: ${err.message}`);
    }
  } else if (text.startsWith("/beripakan")) {
    // Format: /beripakan kolam1 5
    const [, kolam, durasiStr] = text.split(" ");
    if (!kolam || !durasiStr) {
      await bot.sendMessage(chatId, "Format salah. Gunakan: /beripakan kolam1 5 (atau kolam2 5)");
      return;
    }
    const duration = parseInt(durasiStr, 10);
    if ((kolam !== "kolam1" && kolam !== "kolam2") || isNaN(duration) || duration <= 0) {
      await bot.sendMessage(chatId, "Kolam harus 'kolam1' atau 'kolam2' dan durasi harus angka > 0. Contoh: /beripakan kolam1 5");
      return;
    }
    await bot.sendMessage(chatId, `Menggerakkan motor untuk ${kolam} selama ${duration} detik...`);
    try {
      await moveMotor(kolam, duration);
      await bot.sendMessage(chatId, `Pemberian pakan untuk ${kolam} selama ${duration} detik selesai.`);
    } catch (err) {
      await bot.sendMessage(chatId, `Gagal memberi pakan: ${err.message}`);
    }
  } else if (text.startsWith("/espnotif")) {
    // /espnotif off atau /espnotif on
    const [, param] = text.split(" ");
    if (param === "off") {
      setEsp32NotifStatus(false);
      await bot.sendMessage(chatId, "Notifikasi ESP32 down dimatikan.");
    } else if (param === "on") {
      setEsp32NotifStatus(true);
      await bot.sendMessage(chatId, "Notifikasi ESP32 down diaktifkan.");
    } else {
      await bot.sendMessage(chatId, `Status notifikasi ESP32 saat ini: ${getEsp32NotifStatus() ? "AKTIF" : "NONAKTIF"}.\nGunakan /espnotif on atau /espnotif off.`);
    }
  } else {
    await bot.sendMessage(chatId, "Perintah tidak dikenal. Gunakan /help untuk melihat daftar command.");
  }
}

module.exports = { handleTelegramCommand };