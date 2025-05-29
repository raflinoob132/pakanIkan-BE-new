//inisialisasi bot Telegram
const TelegramBot = require("node-telegram-bot-api");
const { handleTelegramCommand } = require("../logic/commandHandler");
const { setBotAndChatId } = require("./telegramUtils");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ENV_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Ambil chat id dari env

if (!TOKEN) {
  throw new Error("Telegram bot token tidak ditemukan. Pastikan TELEGRAM_BOT_TOKEN diatur di environment variables.");
}
if (!ENV_CHAT_ID) {
  throw new Error("Telegram chat id tidak ditemukan. Pastikan TELEGRAM_CHAT_ID diatur di environment variables.");
}

// ...existing code...

const bot = new TelegramBot(TOKEN, { polling: true });
const chatId = ENV_CHAT_ID; // Ambil dari env

async function initTelegramBot() {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    setBotAndChatId(bot, chatId);

    await handleTelegramCommand(text, chatId, bot);
  });
}

module.exports = { initTelegramBot, bot, chatId };
// Fungsi untuk mengirim pesan ke Telegram tanpa perlu memasukkan chatId
// async function sendTelegramMessage(message) {
//   if (!globalChatId) {
//     console.error("Chat ID belum disimpan. Pastikan bot menerima pesan terlebih dahulu.");
//     return;
//   }

//   if (!message || message.trim() === "") {
//     console.error("Parameter message tidak valid.");
//     return;
//   }

//   try {
//     await bot.sendMessage(globalChatId, message);
//     console.log(`Pesan berhasil dikirim ke chatId ${globalChatId}: ${message}`);
//   } catch (err) {
//     console.error("Gagal mengirim pesan ke Telegram:", err);
//   }
// }

// // Fungsi untuk mengirim gambar ke Telegram tanpa perlu memasukkan chatId
// async function sendTelegramImage(imageUrl, caption = "") {
//   if (!globalChatId) {
//     console.error("Chat ID belum disimpan. Pastikan bot menerima pesan terlebih dahulu.");
//     return;
//   }

//   if (!imageUrl) {
//     console.error("Parameter imageUrl tidak valid.");
//     return;
//   }

//   try {
//     await bot.sendPhoto(globalChatId, imageUrl, { caption });
//     console.log(`Gambar berhasil dikirim ke chatId ${globalChatId} dengan caption: ${caption}`);
//   } catch (err) {
//     console.error("Gagal mengirim gambar ke Telegram:", err);
//   }
// }

// // Ganti askUser dengan versi Telegram
// async function askUserTelegramFood(question) {
//   await sendTelegramMessage(question); // Kirim pertanyaan ke Telegram

//   return new Promise((resolve) => {
//     const handler = (msg) => {
//       if (msg.chat.id === globalChatId) {
//         const answer = msg.text.trim().toLowerCase();
//         if (answer === "y" || answer === "n") {
//           bot.removeListener("message", handler); // Hapus listener setelah dapat jawaban
//           resolve(answer === "y");
//         } else {
//           sendTelegramMessage("Jawab dengan 'y' atau 'n' saja.");
//         }
//       }
//     };
//     bot.on("message", handler);
//   });
// }

//module.exports = { initTelegramBot,bot,chatId};
