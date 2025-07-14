const { getSchedule } = require("./scheduleFunctions");

// Fungsi untuk menambah 7 jam pada string waktu "HH:mm"
function add7Hours(timeStr) {
  const [hour, minute] = timeStr.split(":").map(Number);
  let date = new Date(2000, 0, 1, hour, minute);
  date.setHours(date.getHours() + 7);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

async function viewSchedule() {
  const schedules = await getSchedule();
  if (!schedules) return "Belum ada jadwal yang tersimpan.";

  let result = "Daftar Jadwal:\n";
  for (const kolam in schedules) {
    result += `\n${kolam}:\n`;
    for (const jadwal in schedules[kolam]) {
      const { currentTime, doneToday } = schedules[kolam][jadwal];
      result += `  ${jadwal}: ${add7Hours(currentTime)} (${doneToday ? "Sudah" : "Belum"})\n`;
    }
  }
  return result;
}

module.exports = { viewSchedule };