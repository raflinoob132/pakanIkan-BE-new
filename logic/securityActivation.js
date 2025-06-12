const { checkSecurity } = require("./securityCheck");
// ...existing code...
const { db } = require("../config/firebase");

let securityInterval = null;
let securityActive = false;

async function resetAllJarakKeamanan() {
  const snapshot = await db.ref("JarakKeamanan").once("value");
  const sensors = snapshot.val();
  if (sensors) {
    for (const sensor in sensors) {
      await db.ref(`JarakKeamanan/${sensor}`).set(0);
    }
  }
}
async function startSecurityCheck() {
  if (!securityActive) {
    securityActive = true;
    await resetAllJarakKeamanan(); // <-- reset ke 0 di awal aktivasi
    checkSecurity();
    securityInterval = setInterval(() => {
      checkSecurity();
    }, 5000);
    console.log("Security check activated.");
  }
}

function stopSecurityCheck() {
  if (securityActive) {
    clearInterval(securityInterval);
    securityActive = false;
    console.log("Security check deactivated.");
  }
}

module.exports = { startSecurityCheck, stopSecurityCheck, securityActive };