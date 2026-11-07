const cron = require("node-cron");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const { generateReport } = require("./reportGenerator");

const REPORTS_FILE = path.join(__dirname, "..", "db", "reports.json");
const USERS_FILE = path.join(__dirname, "..", "db", "users.json");

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function loadReports() {
  if (!fs.existsSync(REPORTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveReport(report) {
  const reports = loadReports();
  reports.push(report);
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

// Configure email transporter with Gmail
// User needs to:
// 1. Enable 2FA on Gmail account
// 2. Create an App Password: https://myaccount.google.com/apppasswords
// 3. Set EMAIL_USER and EMAIL_PASS environment variables
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Send report email to a user
 */
async function sendReportEmail(userEmail, reportData, period) {
  try {
    const subject = `📊 Your CreatorLand ${period === "weekly" ? "Weekly" : "Monthly"} Report`;

    const mailOptions = {
      from: process.env.EMAIL_USER || "noreply@creatorland.com",
      to: userEmail,
      subject,
      html: reportData.html,
      text: `Your CreatorLand ${period} report is ready.\n\nTotal Clicks: ${reportData.stats.totalClicks}\nTop Source: ${reportData.stats.topSource}\n\nView your dashboard: http://localhost:3000/pages.html`,
    };

    // These count toward the same Gmail account's day as the app's other
    // email (utils/mailer.js): past their share, a report waits for next time.
    const giveBack = require("./mailer").reserve(1, { pool: "reports" });
    if (!giveBack) {
      console.warn("Report skipped: over the day's email budget");
      return false;
    }
    try {
      await transporter.sendMail(mailOptions);
    } catch (e) {
      giveBack();
      throw e;
    }
    console.log(`✅ ${period.toUpperCase()} report sent to ${userEmail}`);

    // Save report to database
    saveReport({
      id: Math.random().toString(36).substring(7),
      userEmail,
      period,
      stats: reportData.stats,
      sentAt: new Date().toISOString(),
    });

    return true;
  } catch (error) {
    console.error(`❌ Failed to send report to ${userEmail}:`, error.message);
    return false;
  }
}

/**
 * Generate and send reports for all users
 */
async function sendReportsToAllUsers(period) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn(
      "⚠️  EMAIL_USER or EMAIL_PASS not set. Skipping report generation."
    );
    return;
  }

  console.log(`🔔 Generating ${period} reports for all users...`);

  const users = loadUsers();
  let sentCount = 0;

  for (const user of users) {
    const reportData = generateReport(user.email, period);
    const success = await sendReportEmail(user.email, reportData, period);
    if (success) sentCount++;
  }

  console.log(`📬 ${period} reports: ${sentCount}/${users.length} sent successfully`);
}

/**
 * Schedule weekly reports (Every Monday at 9:00 AM)
 */
function scheduleWeeklyReports() {
  cron.schedule("0 9 * * 1", async () => {
    console.log("📅 Weekly report scheduler triggered");
    await sendReportsToAllUsers("weekly");
  });
  console.log("✅ Weekly report scheduler active (Mondays at 9:00 AM)");
}

/**
 * Schedule monthly reports (1st of each month at 9:00 AM)
 */
function scheduleMonthlyReports() {
  cron.schedule("0 9 1 * *", async () => {
    console.log("📅 Monthly report scheduler triggered");
    await sendReportsToAllUsers("monthly");
  });
  console.log("✅ Monthly report scheduler active (1st of each month at 9:00 AM)");
}

/**
 * Initialize all schedulers
 */
function initializeSchedulers() {
  console.log("🚀 Initializing report schedulers...");

  if (process.env.REPORTS_ENABLED !== "false") {
    scheduleWeeklyReports();
    scheduleMonthlyReports();
  } else {
    console.log("⚠️  Report schedulers disabled (set REPORTS_ENABLED=true to enable)");
  }
}

module.exports = {
  initializeSchedulers,
  sendReportEmail,
  sendReportsToAllUsers,
  generateReport: generateReport,
};
