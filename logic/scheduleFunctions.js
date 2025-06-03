const { admin, db } = require("../config/firebase");

function subtract7Hours(timeStr) {
  // timeStr: "HH:mm"
  const [hour, minute] = timeStr.split(":").map(Number);
  let date = new Date(Date.UTC(2000, 0, 1, hour, minute)); // tanggal dummy
  date.setUTCHours(date.getUTCHours() - 7);
  // Format kembali ke "HH:mm" (2 digit)
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

async function setSchedule(kolam, jadwalKey, time, isDefault = false) {
  if (!["jadwal1", "jadwal2", "jadwal3", "jadwal4"].includes(jadwalKey)) {
    throw new Error("Hanya bisa memiliki jadwal1 sampai jadwal4.");
  }

  // Kurangi 7 jam dari waktu user
  const timeUTC = subtract7Hours(time);

  const ref = db.ref(`feedingSchedules/${kolam}/${jadwalKey}`);
  const snapshot = await ref.once("value");
  const jadwal = snapshot.val();

  if (isDefault || !jadwal) {
    await ref.set({
      defaultTime: timeUTC,
      currentTime: timeUTC,
      duration: 0.25,
      doneToday: false
    });
  } else {
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