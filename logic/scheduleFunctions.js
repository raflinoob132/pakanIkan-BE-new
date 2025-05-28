const { admin, db } = require("../config/firebase");

async function setSchedule(kolam, jadwalKey, time, isDefault = false) {
  if (!["jadwal1", "jadwal2", "jadwal3", "jadwal4"].includes(jadwalKey)) {
    throw new Error("Hanya bisa memiliki jadwal1 sampai jadwal4.");
  }

  const ref = db.ref(`feedingSchedules/${kolam}/${jadwalKey}`);
  const snapshot = await ref.once("value");
  const jadwal = snapshot.val();

  // Jika set default, update kedua kolom
  if (isDefault || !jadwal) {
    await ref.set({
      defaultTime: time,
      currentTime: time,
      duration: 5,
      doneToday: false
    });
  } else {
    // Jika bukan default, hanya update currentTime
    await ref.update({
      currentTime: time,
      doneToday: false
    });
  }
}

async function getSchedule() {
  const snapshot = await db.ref("feedingSchedules").once("value");
  return snapshot.val();
}


module.exports = { setSchedule, getSchedule };
