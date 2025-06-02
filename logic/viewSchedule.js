const { getSchedule } = require("./scheduleFunctions");

async function viewSchedule() {
  const schedules = await getSchedule();
  if (!schedules) return "Belum ada jadwal yang tersimpan.";

  let result = "Daftar Jadwal:\n";
  for (const kolam in schedules) {
    result += `\n${kolam}:\n`;
    for (const jadwal in schedules[kolam]) {
      const { currentTime, doneToday } = schedules[kolam][jadwal];
      result += `  ${jadwal}: ${currentTime} (${doneToday ? "Sudah" : "Belum"})\n`;
    }
  }
  return result;
}

module.exports = { viewSchedule };