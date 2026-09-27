
const express = require('express');
const cors = require('cors');
const { admin, auth, db } = require('./auth/firebase-admin');
const config = require('./config/config')
const { testS3Connection } = require('./database/s3');
const cron = require('node-cron');
const axios = require("axios");


require('dotenv').config();



const initializeDatabases = require('./database/pgInit')


process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  // consider: gracefully drain and restart via your process manager
  // rather than letting it die silently mid-request
});


// CORS configuration
const corsOptions = {
  origin: config.CORS_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'x-client-type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    '*',
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
};


const app = express();

app.use(cors(corsOptions));
app.use(express.json());

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow:'); // or your preferred robots.txt content
});

app.get('/sitemap.xml', (req, res) => {
  res.status(404).send('Not Found'); // or serve actual sitemap
});

app.get('/favicon.ico', (req, res) => {
  res.status(404).send('Not Found'); // or serve actual favicon
});




const isProduction = 'production';



app.get('/health', (req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: Date.now()
  });
});






// For Booking Link
app.use('/api/booking-link', require('./booking/api/user/userRoutes.js'))
app.use('/api/booking-link', require('./booking/api/booking/bookingRoutes.js'))
app.use('/api/booking-link', require('./booking/api/booking/slugRoutes.js'))
app.use('/api/booking-link', require('./booking/api/telegram/telegramRoutes.js'))


// For view tracking
app.use('/api/booking-link', require('./api/tracker/trackViewRoutes.js'))

async function startServer() {
  const TZ = "Asia/Phnom_Penh";
  const isDev = process.env.NODE_ENV === "development";

  function isActiveHours(tz, startHour = 9, endHour = 21) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: tz,
      }).format(new Date())
    );
    return hour >= startHour && hour < endHour;
  }

  const PORT = 9000;
  const isProductionTest = config.isProductionTest?.() || false;

  function localhostOnly(req, res, next) {
    const ip = req.socket.remoteAddress;
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      return next();
    }
    res.status(404).end();
  }

  console.log("\n🚀 Starting server...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`🔧 Environment: ${process.env.NODE_ENV}${isProductionTest ? " (Production Test)" : ""}`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔌 Backend URL: ${process.env.NEXT_PUBLIC_BACKEND || "Not set"}`);

  try {
    const s3Connected = await testS3Connection();
    if (s3Connected) {
      console.log("S3 bucket is configured correctly");
    }
  } catch (error) {
    console.error("S3 bucket configuration failed");
  }

  initializeDatabases().catch(console.error);

  

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port: ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
    console.log("Client:", process.env.NEXT_PUBLIC_BACKEND);

  
  });
}
startServer()