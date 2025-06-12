const { db } = require("../config/firebase");

// Antrean promise untuk proses servo & kamera
let servoQueue = Promise.resolve();

function moveServoAndTakePhoto(servoCommand, tujuan) {
  // Setiap pemanggil akan otomatis mengantri
  servoQueue = servoQueue.then(() => _moveServoAndTakePhoto(servoCommand, tujuan));
  return servoQueue;
}

async function _moveServoAndTakePhoto(servoCommand, tujuan) {
  console.log(`Memulai proses ${tujuan} dengan command ${servoCommand}`);

  // Kirim perintah untuk menggerakkan servo
  await db.ref("checkCameraMoveCommand").set({
    moveServo: servoCommand,
    status: 1,
  });

  // Tunggu hingga ESP32 mengembalikan status ke 0
  await new Promise((resolveStatus) => {
    const interval = setInterval(async () => {
      const cameraCommandSnapshot = await db.ref("checkCameraMoveCommand").once("value");
      const cameraCommand = cameraCommandSnapshot.val();
      if (cameraCommand.status === 0) {
        clearInterval(interval);
        resolveStatus();
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
  await new Promise((resolveTarget) => {
    const interval = setInterval(async () => {
      const targetColumnSnapshot = await db.ref(targetColumn).once("value");
      const targetColumnValue = targetColumnSnapshot.val();
      if (targetColumnValue === 0) {
        clearInterval(interval);
        resolveTarget();
      }
    }, 1000);
  });

  console.log(`Proses ${tujuan} selesai.`);
}

module.exports = { moveServoAndTakePhoto };