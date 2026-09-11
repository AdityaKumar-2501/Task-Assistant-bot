import cron from "node-cron";
import { config } from "./config.js";
import { getDueTasks, markReminderSent, getTasksForDailySummary, countIgnoredReminders } from "./tasks.js";
import { getRecentMemories } from "./memories.js";
import { Telegraf } from "telegraf";

function dayRangeIST(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const day = formatter.format(date);
  return {
    start: new Date(`${day}T00:00:00+05:30`),
    end: new Date(`${day}T23:59:59.999+05:30`)
  };
}

export function startSchedulers(bot: Telegraf) {
  // Every minute: send due reminders.
  cron.schedule("* * * * *", async () => {
    try {
      const due = await getDueTasks();

      for (const task of due) {
        const tooSoon =
          task.lastRemindedAt &&
          Date.now() - task.lastRemindedAt.getTime() <
            config.reminderIntervalMinutes * 60_000;

        if (tooSoon) continue;

        await bot.telegram.sendMessage(
          task.chatId,
          `🔔 Reminder\n\n☐ ${task.title}\n\nReply "done ${task.title}" when finished, or "snooze ${task.title} by 30 minutes".`
        );

        if (task._id) await markReminderSent(task._id);
      }
    } catch (error) {
      console.error("Reminder worker error:", error);
    }
  }, { timezone: config.timezone });

  // Every minute, but only sends at the configured local time.
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);

    const hour = Number(parts.find(p => p.type === "hour")?.value);
    const minute = Number(parts.find(p => p.type === "minute")?.value);

    if (hour !== config.summaryHour || minute !== config.summaryMinute) return;

    // This process may restart and send twice around the same minute.
    // A production version should persist a "dailySummarySent" record.
    try {
      const { start, end } = dayRangeIST(now);
      const users = new Map<number, number>();

      const tasks = await getDueTasks(new Date());
      for (const task of tasks) users.set(task.userId, task.chatId);

      // Also discover users from recent memories.
      const recent = await getRecentMemories(0, 0).catch(() => []);
      void recent;

      // For the MVP, summary is sent to chats that have at least one task today.
      const { db } = await import("./db.js");
      const todayTasks = await db().collection("tasks").find({
        createdAt: { $lt: end },
        $or: [
          { scheduledAt: { $gte: start, $lt: end } },
          { completedAt: { $gte: start, $lt: end } }
        ]
      }).toArray();

      for (const t of todayTasks) users.set(t.userId, t.chatId);

      for (const [userId, chatId] of users) {
        const userTasks = await getTasksForDailySummary(userId, start, end);
        const ignored = await countIgnoredReminders(userId, start, end);

        const memories = await getRecentMemories(userId, 20);
        const todayMemories = memories.filter(m => m.createdAt >= start && m.createdAt < end);

        const completed = userTasks.filter(t => t.status === "completed").length;
        const skipped = userTasks.filter(t => t.status === "skipped").length;
        const pending = userTasks.filter(t => t.status === "pending").length;
        const late = userTasks.filter(t =>
          t.status === "completed" &&
          t.completedAt &&
          t.completedAt.getTime() > t.scheduledAt.getTime()
        ).length;

        let text = `🌙 Daily Review\n\n`;
        text += `Tasks\n`;
        text += `✅ Completed: ${completed}\n`;
        text += `⏰ Completed late: ${late}\n`;
        text += `❌ Remaining: ${pending}\n`;
        text += `⏭️ Skipped: ${skipped}\n`;
        text += `🔔 Unanswered reminders: ${ignored}\n`;

        if (todayMemories.length) {
          text += `\n🧠 Things you asked me to remember\n`;
          text += todayMemories.slice(0, 10).map(m => `• ${m.content}`).join("\n");
        }

        if (pending) {
          text += `\n\n📌 Still pending\n`;
          text += userTasks.filter(t => t.status === "pending")
            .map(t => `• ${t.title}`).join("\n");
        }

        await bot.telegram.sendMessage(chatId, text);
      }
    } catch (error) {
      console.error("Daily summary error:", error);
    }
  }, { timezone: config.timezone });

  console.log("Schedulers started.");
}
