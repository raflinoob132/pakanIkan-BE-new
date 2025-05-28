const { db } = require('../config/firebase');
const { getSchedule } = require('./scheduleFunctions');
async function resetCurrentTimeAll() {
  const schedules = await getSchedule();
  for (const kolam in schedules) {
    for (const key in schedules[kolam]) {
      const { defaultTime } = schedules[kolam][key];
      await db.ref(`feedingSchedules/${kolam}/${key}/currentTime`).set(defaultTime);
      await db.ref(`feedingSchedules/${kolam}/${key}/doneToday`).set(false);
    }
  }
}

module.exports = {resetCurrentTimeAll };
