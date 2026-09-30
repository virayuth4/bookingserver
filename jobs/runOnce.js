const { sendBookingReminders } = require("./bookingReminder");

require("dotenv").config();

sendBookingReminders()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });