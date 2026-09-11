import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }

  return value;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),

  geminiApiKey: required("GEMINI_API_KEY"),

  geminiModel:
    process.env.GEMINI_MODEL ?? "gemini-2.5-flash",

  mongoUri:
    process.env.MONGODB_URI ??
    "mongodb://127.0.0.1:27017",

  mongoDb:
    process.env.MONGODB_DB ??
    "personal_assistant",

  timezone:
    process.env.TIMEZONE ??
    "Asia/Kolkata",

  reminderIntervalMinutes:
    Number(
      process.env.REMINDER_INTERVAL_MINUTES ?? 30
    ),

  summaryHour:
    Number(
      process.env.DAILY_SUMMARY_HOUR ?? 23
    ),

  summaryMinute:
    Number(
      process.env.DAILY_SUMMARY_MINUTE ?? 30
    ),
};