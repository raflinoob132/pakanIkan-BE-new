const { db } = require("../config/firebase");
const { sendTelegramMessage } = require("../telegram/telegramUtils");

/**
 * Cek kapasitas pakan pada kotak A atau B.
 * @param {'A'|'B'} kotak - 'A' untuk foodCapacityA, 'B' untuk foodCapacityB
 */
async function checkFoodCapacity(kotak) {
  const checkKey = kotak === "A" ? "foodCapacityCheckA" : "foodCapacityCheckB";
  const valueKey = kotak === "A" ? "foodCapacityA" : "foodCapacityB";

  // 1. Trigger pembacaan sensor dengan mengirim 1 ke kolom check
  await db.ref(checkKey).set(1);

  // 2. Tunggu hingga kolom check kembali menjadi 0 (artinya pembacaan selesai)
  let maxWait = 10000; // maksimal 10 detik
  let interval = 300;
  let waited = 0;
  while (waited < maxWait) {
    const checkSnap = await db.ref(checkKey).once("value");
    if (checkSnap.val() === 0) break;
    await new Promise(res => setTimeout(res, interval));
    waited += interval;
  }

  // 3. Ambil hasil pembacaan kapasitas
  const valueSnap = await db.ref(valueKey).once("value");
  const kapasitas = valueSnap.val();

  // 4. Kirim hasil ke Telegram
  await sendTelegramMessage(`Kapasitas pakan pada kotak ${kotak}: ${kapasitas} cm`);

  //return kapasitas;
}

module.exports = { checkFoodCapacity };