const cron = require("node-cron");
const { sendBookingReminders } = require("./bookingReminder");

let running = false;

function startJobs() {
  // Every minute. The `running` flag stops runs from overlapping.
 cron.schedule("*/30 * * * * *", async () => {
  console.log("[jobs] tick", new Date().toISOString());
  if (running) return;
  running = true;
  try {
    await sendBookingReminders();
  } catch (err) {
    console.error("[reminders] job error:", err);
  } finally {
    running = false;
  }
});

  console.log("[jobs] scheduled: booking reminders");
}

module.exports = { startJobs };