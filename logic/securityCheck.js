const { db } = require("../config/firebase");
const { moveServoAndTakePhoto } = require("./servoHandler");
const { sendTelegramMessage } = require("../telegram/telegramUtils");
let isChecking = false;

async function checkSecurity() {
  if (isChecking) {
    console.log("Proses pemeriksaan keamanan sedang berlangsung.");
    return;
  }
  isChecking = true;
try{
  const snapshot = await db.ref("JarakKeamanan").once("value");
  const sensors = snapshot.val();

  if (!sensors) {
    console.log("Tidak ada data sensor keamanan.");
    return;
  }

  const servoCommands = {
    sensor1: "170,80",
    sensor2: "10,80"
  };
  const servoCommandsSecond = {
    sensor1: "125,80",      // sudut kedua sensor1
    sensor2: "45,80"        // sudut kedua sensor2
  };
  let adaAncaman = false;

  for (const sensor in sensors) {
    const pirValue = parseInt(sensors[sensor]);
    const flagSnapshot = await db.ref(`AncamanKeamananAktif/${sensor}`).once("value");
    const flagAktif = flagSnapshot.val();

    if (pirValue === 1 && !flagAktif) {
      adaAncaman = true;
      const servoCommand = servoCommands[sensor];
      const pesan = `Ancaman terdeteksi di ${sensor} (PIR aktif). Menggerakkan servo dengan command ${servoCommand}.`;
      console.log(pesan);
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(true);

      await moveServoAndTakePhoto(servoCommand, "keamanan");
      await moveServoAndTakePhoto(servoCommandsSecond[sensor], "keamanan");

      await sendTelegramMessage(`Ancaman terdeteksi di ${sensor}. Proses pengambilan gambar dilakukan`);

      // Reset nilai PIR ke 0 setelah 20 detik
      setTimeout(async () => {
        await db.ref(`JarakKeamanan/${sensor}`).set(0);

        await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);

        console.log(`Reset sensor ${sensor} ke 0 setelah 20 detik.`);
      }, 7000);

    } else if (pirValue === 0 && flagAktif) {
      await db.ref(`AncamanKeamananAktif/${sensor}`).set(false);
      console.log(`Ancaman di ${sensor} sudah pergi, flag direset.`);
      await sendTelegramMessage(`Ancaman di ${sensor} sudah pergi.`);
    }
  }

  if (!adaAncaman) {
    console.log("Tidak ada ancaman keamanan terdeteksi.");
  }
} catch (err) {
    console.error("Error saat cek keamanan:", err);
  } finally {
    isChecking = false;
  }
}
module.exports = { checkSecurity };