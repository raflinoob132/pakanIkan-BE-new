const { checkSecurity } = require("./securityCheck");
// ...existing code...
let securityInterval = null;
let securityActive = false;

function startSecurityCheck() {
  if (!securityActive) {
    securityActive = true;
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