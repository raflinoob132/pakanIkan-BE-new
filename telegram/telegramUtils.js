//fungsi dasar telegram
let botInstance = null;
let chatIdInstance = null;
const { db } = require("../config/firebase");

function setBotAndChatId(bot, chatId) {
  botInstance = bot;
  chatIdInstance = chatId;
}

async function sendTelegramMessage(message) {
  if (!chatIdInstance) {
    console.error("Chat ID belum disimpan. Pastikan bot menerima pesan terlebih dahulu.");
    return;
  }

  if (!message || message.trim() === "") {
    console.error("Parameter message tidak valid.");
    return;
  }

  try {
    await botInstance.sendMessage(chatIdInstance, message);
    console.log(`Pesan berhasil dikirim ke chatId ${chatIdInstance}: ${message}`);
  } catch (err) {
    console.error("Gagal mengirim pesan ke Telegram:", err);
  }
}

// Fungsi untuk mengirim gambar ke Telegram tanpa perlu memasukkan chatId
async function sendTelegramImage(imageUrl, caption = "") {
  if (!chatIdInstance) {
    console.error("Chat ID belum disimpan. Pastikan bot menerima pesan terlebih dahulu.");
    return;
  }

  if (!imageUrl) {
    console.error("Parameter imageUrl tidak valid.");
    return;
  }

  try {
    await botInstance.sendPhoto(chatIdInstance, imageUrl, { caption });
    console.log(`Gambar berhasil dikirim ke chatId ${chatIdInstance} dengan caption: ${caption}`);
  } catch (err) {
    console.error("Gagal mengirim gambar ke Telegram:", err);
  }
}

// Ganti askUser dengan versi Telegram
// ...existing code...

async function askUserTelegramFood(question) {
  await sendTelegramMessage(question); // Kirim pertanyaan ke Telegram

  return new Promise((resolve) => {
    const handler = async (msg) => {
      if (msg.chat.id === chatIdInstance) {
        const answer = msg.text.trim().toLowerCase();
        if (answer === "y" || answer === "n") {
          botInstance.removeListener("message", handler); // Hapus listener setelah dapat jawaban
          // Simpan ke Firebase
          const noFoodInPond = answer === "y" ? 1 : 0;
          try {
            await db.ref(`noFoodInPond`).set(noFoodInPond);
            console.log(`noFoodInPond diset ke ${noFoodInPond}`);
          } catch (err) {
            console.error("Gagal menyimpan noFoodInPond ke Firebase:", err);
          }
          resolve(answer === "y");
        } else {
          sendTelegramMessage("Jawab dengan 'y' atau 'n' saja.");
        }
      }
    };
    botInstance.on("message", handler);
  });
}

// ...existing code...

module.exports = { setBotAndChatId, sendTelegramMessage, sendTelegramImage, askUserTelegramFood };