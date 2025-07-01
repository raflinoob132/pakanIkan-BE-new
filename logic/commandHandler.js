const { setSchedule, getSchedule,deleteSchedule } = require("./scheduleFunctions");
const { startSecurityCheck, stopSecurityCheck, securityActive } = require("../logic/securityActivation");
const { viewSchedule } = require("./viewSchedule"); // Tambahkan ini
const { checkFoodCapacity } = require("./checkFoodCapacity"); // Tambahkan ini
const { moveServoAndTakePhoto } = require("./servoHandler"); // Pastikan ini sudah ada
const { setEsp32NotifStatus, getEsp32NotifStatus } = require("./monitorESP");

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
      await bot.sendMessage(chatId, "Security check diaktifkan (setiap 5 detik).");
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
/help                        - Lihat daftar command
/hapusjadwal <kolam> <jadwal> - Hapus jadwal (contoh: /hapusjadwal kolam1 jadwal2)
/espnotif on|off              - Aktifkan/matikan notifikasi ESP32 down    
`;
    await bot.sendMessage(chatId, helpMessage);
  }else if (text.startsWith("/cekpakan")) {
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