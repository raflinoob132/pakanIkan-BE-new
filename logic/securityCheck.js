const { db } = require("../config/firebase");
const { moveServoAndTakePhoto } = require("./servoHandler");
const { sendTelegramMessage } = require("../telegram/telegramUtils"); // Tambahkan ini

async function checkSecurity() {
  const snapshot = await db.ref("JarakKeamanan").once("value");
  const sensors = snapshot.val();

  if (!sensors) {
    console.log("Tidak ada data sensor keamanan.");
    return;
  }

  const servoCommands = {
    sensor1: "10,20",
    sensor2: "30,40",
    sensor3: "50,60",
    sensor4: "70,80"
  };

  let adaAncaman = false;

  for (const sensor in sensors) {
    const jarak = parseFloat(sensors[sensor]);
    const flagSnapshot = await db.ref(`AncamanKeamananAktif/${sensor}`).once("value");
    const flagAktif = flagSnapshot.val();

    if (jarak < 10 && !flagAktif) {
      adaAncaman = true;
      const servoCommand = servoCommands[sensor] || "0,0";
      const pesan = `Ancaman terdeteksi di ${sensor} (jarak: ${jarak}). Menggerakkan servo dengan command ${servoCommand}.`;
      console.log(pesan);
      await moveServoAndTakePhoto(servoCommand, "keamanan");
      await sendTelegramMessage(pesan); // Kirim ke Telegram
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(true);
    } else if (jarak >= 10 && flagAktif) {
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);
      console.log(`Ancaman di ${sensor} sudah pergi, flag direset.`);
    }
  }

  if (!adaAncaman) {
    console.log("Tidak ada ancaman keamanan terdeteksi.");
  }
}

module.exports = { checkSecurity };