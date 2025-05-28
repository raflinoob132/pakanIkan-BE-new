const { db } = require("../config/firebase");
const { enqueue } = require("./servoQueue");

async function moveServoAndTakePhoto(servoCommand, tujuan) {
  enqueue(async () => {
    console.log(`Memulai proses ${tujuan} dengan command ${servoCommand}`);

    try {
      // Kirim perintah untuk menggerakkan servo
      await db.ref("checkCameraMoveCommand").set({
        moveServo: servoCommand,
        status: 1,
      });

      // Tunggu hingga ESP32 mengembalikan status ke 0
      await new Promise((resolve) => {
        const interval = setInterval(async () => {
          const cameraCommandSnapshot = await db.ref("checkCameraMoveCommand").once("value");
          const cameraCommand = cameraCommandSnapshot.val();
          if (cameraCommand.status === 0) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });

      let targetColumn;
      if (tujuan === "makanan") {
        targetColumn = "cekkamera";
      } else if (tujuan === "keamanan") {
        targetColumn = "cekKeamanan";
      } else {
        throw new Error("Parameter tujuan tidak valid. Gunakan 'makanan' atau 'keamanan'.");
      }

      // Kirim perintah ke kolom yang sesuai untuk memulai proses
      await db.ref(targetColumn).set(1);

      // Tunggu hingga ESP32-CAM mengembalikan nilai 0
      await new Promise((resolve) => {
        const interval = setInterval(async () => {
          const targetColumnSnapshot = await db.ref(targetColumn).once("value");
          const targetColumnValue = targetColumnSnapshot.val();
          if (targetColumnValue === 0) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });

      console.log(`Proses ${tujuan} selesai.`);
    } catch (err) {
      console.error(`Error pada proses ${tujuan}:`, err);
    }
  });
}

module.exports = { moveServoAndTakePhoto };
