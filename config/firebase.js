// /config/firebase.js
require('dotenv').config();

const admin = require("firebase-admin");
const serviceAccount = require(process.env.FIREBASECREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
   databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

module.exports = { admin, db };
