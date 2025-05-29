const { setSchedule, getSchedule } = require("./scheduleFunctions");
const { startSecurityCheck, stopSecurityCheck, securityActive } = require("../logic/securityActivation");

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
  } else if (text.startsWith("/list")) {
    const schedules = await getSchedule();
    await bot.sendMessage(chatId, JSON.stringify(schedules, null, 2));
  } else if (text.startsWith("/security")) {
    const [, action] = text.split(" ");
    if (action === "on") {
      startSecurityCheck();
      await bot.sendMessage(chatId, "Security check diaktifkan (setiap 5 detik).");
    } else if (action === "off") {
      stopSecurityCheck();
      await bot.sendMessage(chatId, "Security check dimatikan.");
    }
  } else if (text.startsWith("/help")) {
    const helpMessage = `
Daftar Command:
/set <kolam> <jadwal> <jam>  - Set jadwal (contoh: /set kolam1 jadwal2 08:00)
/list                        - Lihat semua jadwal
/security on                 - Aktifkan security check
/security off                - Matikan security check
/help                        - Lihat daftar command
    `;
    await bot.sendMessage(chatId, helpMessage);
  } else {
    await bot.sendMessage(chatId, "Perintah tidak dikenal. Gunakan /help untuk melihat daftar command.");
  }
}

module.exports = { handleTelegramCommand };