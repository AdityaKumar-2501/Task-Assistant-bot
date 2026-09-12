import { Telegraf, Markup } from "telegraf";
import http from "node:http";

import { config } from "./config.js";
import { connectDb } from "./db.js";
import {
  getPendingTasks,
  completeTaskByText,
  skipTaskByText,
  unskipTaskByText,
  getSkippedTasks,
  deleteTaskByText,
  clearAllPendingTasks,
  createTask
} from "./tasks.js";
import { saveMemory, getRecentMemories } from "./memories.js";
import { startSchedulers } from "./reminders.js";
import {
  getDailyAnalytics,
} from "./analytics.js";
import {
  getWeeklyAnalytics,
  getWeeklyTrend,
} from "./analytics.js";
import {
  getMonthlyAnalytics,
  getMonthlyTrend,
} from "./analytics.js";

const bot = new Telegraf(config.telegramToken);


/**
 * MANUAL "ADD TASK" FLOW (no AI involved)
 * ------------------------------------------------------------
 * A guided, button/step based flow for creating a task without
 * going through Gemini at all — triggered by /addtask from
 * Telegram's command menu. State is kept per-user in memory while
 * they're mid-flow; a plain text reply during an active draft is
 * treated as flow input and never reaches the AI handler below.
 */
type TaskDraft =
  | { step: "title" }
  | { step: "date"; title: string }
  | { step: "custom_date"; title: string }
  | { step: "time"; title: string; dateStr: string }
  | { step: "description"; title: string; dateStr: string; time: string };

const taskDrafts = new Map<number, TaskDraft>();

/** Today's calendar date (YYYY-MM-DD) as seen in the configured timezone. */
function todayInTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

/** Adds N calendar days to a YYYY-MM-DD string (pure date arithmetic). */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Validates and normalizes a user-typed date like "25/12/2026" or "2026-12-25". */
function parseDateInput(text: string): string | null {
  const trimmed = text.trim();

  // YYYY-MM-DD
  let match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, y, m, d] = match;
    return isValidDate(Number(y), Number(m), Number(d))
      ? `${y}-${m}-${d}`
      : null;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    const dd = d.padStart(2, "0");
    const mm = m.padStart(2, "0");
    return isValidDate(Number(y), Number(mm), Number(dd))
      ? `${y}-${mm}-${dd}`
      : null;
  }

  return null;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** Parses a user-typed time like "8pm", "8:30 PM", or "20:30" into 24h "HH:mm". */
function parseTimeInput(text: string): string | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Converts a wall-clock date + time in the given IANA timezone into
 * the correct UTC Date instant — works for any timezone (handles
 * DST correctly), not just fixed-offset ones.
 */
function zonedDateTimeToUtc(
  dateStr: string,
  time24: string,
  timeZone: string
): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = time24.split(":").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
    .formatToParts(utcGuess)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  const offset = utcGuess.getTime() - asIfUtc;

  return new Date(utcGuess.getTime() + offset);
}

function formatDateLabel(dateStr: string, timeZone: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    timeZone: "UTC", // dateStr is a plain calendar date, not an instant
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

function dateChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Today", "task_date:today"),
      Markup.button.callback("Tomorrow", "task_date:tomorrow")
    ],
    [Markup.button.callback("Custom date", "task_date:custom")],
    [Markup.button.callback("❌ Cancel", "task_cancel")]
  ]);
}

function descriptionChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Skip", "task_desc:skip")],
    [Markup.button.callback("❌ Cancel", "task_cancel")]
  ]);
}

async function finalizeTaskDraft(
  ctx: any,
  draft: { title: string; dateStr: string; time: string },
  description?: string
) {
  const scheduledAt = zonedDateTimeToUtc(
    draft.dateStr,
    draft.time,
    config.timezone
  );

  const task = await createTask({
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    title: draft.title,
    scheduledAt: scheduledAt.toISOString(),
    description
  });

  const when = formatDateLabel(draft.dateStr, config.timezone);
  const [hh, mm] = draft.time.split(":").map(Number);
  const timeLabel = new Date(Date.UTC(2000, 0, 1, hh, mm)).toLocaleTimeString(
    "en-IN",
    { timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true }
  );

  await ctx.reply(
    `✅ *Task created*\n\n*${task.title}*\n🕐 ${when}, ${timeLabel}` +
      (description ? `\n📝 ${description}` : ""),
    { parse_mode: "Markdown" }
  );
}

/**
 * /addtask — starts the guided, non-AI task creation flow.
 */
bot.command("addtask", async ctx => {
  taskDrafts.set(ctx.from.id, { step: "title" });

  await ctx.reply(
    "📝 Let's add a task.\n\nWhat's the task title?\n\n_(Send /canceltask anytime to cancel.)_",
    { parse_mode: "Markdown" }
  );
});

/**
 * /canceltask — aborts an in-progress draft.
 */
bot.command("canceltask", async ctx => {
  const hadDraft = taskDrafts.delete(ctx.from.id);

  await ctx.reply(
    hadDraft ? "Cancelled." : "You don't have a task in progress."
  );
});

bot.action("task_cancel", async ctx => {
  taskDrafts.delete(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.editMessageText("Cancelled.");
});

bot.action(/^task_date:(today|tomorrow|custom)$/, async ctx => {
  const draft = taskDrafts.get(ctx.from.id);

  if (!draft || draft.step !== "date") {
    await ctx.answerCbQuery("This step has expired.");
    return;
  }

  const choice = ctx.match[1];
  await ctx.answerCbQuery();

  if (choice === "custom") {
    taskDrafts.set(ctx.from.id, { step: "custom_date", title: draft.title });
    await ctx.editMessageText(
      "Enter the date (DD/MM/YYYY or YYYY-MM-DD):"
    );
    return;
  }

  const dateStr =
    choice === "today"
      ? todayInTimezone(config.timezone)
      : addDays(todayInTimezone(config.timezone), 1);

  taskDrafts.set(ctx.from.id, {
    step: "time",
    title: draft.title,
    dateStr
  });

  await ctx.editMessageText(
    `Date: ${formatDateLabel(dateStr, config.timezone)}\n\nWhat time? (e.g. "8pm" or "20:00")`
  );
});

bot.action("task_desc:skip", async ctx => {
  const draft = taskDrafts.get(ctx.from.id);

  if (!draft || draft.step !== "description") {
    await ctx.answerCbQuery("This step has expired.");
    return;
  }

  await ctx.answerCbQuery();
  taskDrafts.delete(ctx.from.id);

  try {
    await finalizeTaskDraft(ctx, draft);
  } catch (error) {
    console.error("Error creating task:", error);
    await ctx.reply("Sorry, something went wrong creating that task.");
  }
});

function formatTime(date: Date) {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: config.timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }
  ).format(date);
}

async function buildDailySummary(
  userId: number
) {
  const analytics =
    await getDailyAnalytics(
      userId,
      new Date(),
      config.timezone
    );

  const completed = analytics.tasks.filter(
    (task) =>
      task.status === "completed" &&
      task.completedAt
  );

  const skipped = analytics.tasks.filter(
    (task) =>
      task.status === "skipped"
  );

  const incomplete = analytics.tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.scheduledAt < new Date()
  );

  let message = `🌙 TODAY'S REVIEW

🎯 YOUR DAY
• ${analytics.planned} tasks planned
• ${analytics.completed} completed
• ${analytics.skipped} skipped
• ${analytics.incomplete} incomplete

Completion rate: ${analytics.completionRate}%

━━━━━━━━━━━━━━━━

`;

  if (completed.length > 0) {
    message += `✅ COMPLETED\n\n`;

    for (const task of completed) {
      const late =
        task.completedAt! >
        task.scheduledAt;

      message += `${late ? "🕐" : "•"} ${
        task.title
      } — completed at ${formatTime(
        task.completedAt!
      )}`;

      if (late) {
        message += " (late)";
      }

      message += "\n";
    }

    message += "\n━━━━━━━━━━━━━━━━\n\n";
  }

  if (incomplete.length > 0) {
    message += `⏳ NOT FINISHED\n\n`;

    for (const task of incomplete) {
      message += `• ${task.title} — scheduled ${formatTime(
        task.scheduledAt
      )}\n`;
    }

    message +=
      "\n━━━━━━━━━━━━━━━━\n\n";
  }

  if (skipped.length > 0) {
    message += `⏭️ SKIPPED\n\n`;

    for (const task of skipped) {
      message += `• ${task.title}\n`;
    }

    message +=
      "\n━━━━━━━━━━━━━━━━\n\n";
  }

  message += `⏰ REMINDERS
• ${analytics.tasks.reduce(
    (sum, task) =>
      sum + task.reminderCount,
    0
  )} reminders sent
• ${analytics.ignoredReminders} ignored

━━━━━━━━━━━━━━━━

📊 TIMING
• On time: ${analytics.completedOnTime}
• Completed late: ${analytics.completedLate}
`;

  if (analytics.forwarded > 0) {
    message += `• Carried forward: ${analytics.forwarded}\n`;
  }

  message += `\n━━━━━━━━━━━━━━━━\n\n`;

  // Insight
  if (
    analytics.planned === 0
  ) {
    message +=
      `💡 TODAY'S INSIGHT\n\nNo tasks were planned today.\n\n`;
  } else if (
    analytics.completionRate >= 90
  ) {
    message +=
      `💡 TODAY'S INSIGHT\n\nExcellent day. You completed ${analytics.completionRate}% of your planned tasks. 💪\n\n`;
  } else if (
    analytics.completionRate >= 70
  ) {
    message +=
      `💡 TODAY'S INSIGHT\n\nGood progress. You completed ${analytics.completionRate}% of your planned tasks.\n\n`;
  } else {
    message +=
      `💡 TODAY'S INSIGHT\n\nYou completed ${analytics.completionRate}% of your planned tasks today. Try keeping tomorrow's task list smaller and more focused.\n\n`;
  }

  if (analytics.incomplete > 0) {
    message +=
      `🔄 You have ${analytics.incomplete} unfinished task${
        analytics.incomplete === 1
          ? ""
          : "s"
      } that may need to be moved to another day.`;
  }

  return message;
}

/**
 * SINGLE SOURCE OF TRUTH for every real command this bot supports.
 * Used both to populate Telegram's "/" command menu and to detect
 * unrecognized commands (see bot.on("text", ...) below) — so the
 * menu and the validation can never drift out of sync.
 */
const commandDefinitions: { command: string; description: string }[] = [
  { command: "start", description: "Start the assistant" },
  { command: "help", description: "Learn how to use the assistant" },
  { command: "addtask", description: "Add a task step-by-step" },
  { command: "canceltask", description: "Cancel an in-progress /addtask" },
  { command: "tasks", description: "View your pending tasks" },
  { command: "done", description: "Complete a task" },
  { command: "skip", description: "Skip a task" },
  { command: "unskip", description: "Restore a skipped task back to pending" },
  { command: "skipped", description: "View your skipped tasks" },
  { command: "delete", description: "Delete a task permanently" },
  { command: "cleartasks", description: "Delete all pending tasks" },
  { command: "remember", description: "Remember something" },
  { command: "memories", description: "View your saved memories" },
  { command: "summary", description: "Review today's productivity" },
  { command: "weekly", description: "Review this week's productivity" },
  { command: "monthly", description: "Review this month's productivity" }
];

const knownCommands = new Set(
  commandDefinitions.map(definition => definition.command)
);

/**
 * Register Telegram's "/" command menu.
 */
async function setupBotCommands() {
  await bot.telegram.setMyCommands(commandDefinitions);
}

/**
 * Extract text after a Telegram command.
 *
 * Example:
 * /done study DSA
 *
 * returns:
 * study DSA
 */
function getCommandArgument(text: string, command: string): string {
  return text.replace(new RegExp(`^\\/${command}\\s*`, "i"), "").trim();
}

/**
 * /start
 */
bot.start(async ctx => {
  await ctx.reply(
    `👋 *Welcome!*

I’m your personal assistant — here to help you *organize your day, remember important things, and stay on track.*

I work entirely through commands (no AI chat) — fast and predictable every time.

Use the menu below, or type /help for the full list:

➕ /addtask — Add a task step-by-step
📋 /tasks — View your tasks
✅ /done — Complete a task
⏭️ /skip — Skip a task
🗑️ /delete — Delete a task
🧠 /remember — Save something to memory
💭 /memories — View your memories
📊 /summary — View today's summary
❓ /help — Full list of commands

*Tip:* Type /tasks to see what's pending, or /addtask to add something new.`,
    {
      parse_mode: "Markdown"
    }
  );
});

/**
 * /help
 */
bot.command("help", async ctx => {
  await ctx.reply(
    `❓ *How to use your personal assistant*

Everything is command-based — type a command and I'll guide you through it if it needs more info.

*Tasks*

• /addtask — add a task step-by-step (title, date, time, description)
• /tasks — view your pending tasks
• /done \`<task>\` — mark a task complete
• /skip \`<task>\` — skip a task
• /skipped — view your skipped tasks
• /unskip \`<task>\` — restore a skipped task back to pending
• /delete \`<task>\` — permanently delete a task
• /cleartasks — permanently delete all pending tasks

*Memories*

• /remember \`<text>\` — save something to memory
• /memories — view what's been saved

*Daily progress*

• /summary — today's productivity summary
• /weekly — this week's productivity summary
• /monthly — this month's productivity summary

*Other*

• /addtask — add a task step-by-step
• /canceltask — cancel an in-progress /addtask
• /start — show the welcome message again`,
    {
      parse_mode: "Markdown"
    }
  );
});

/**
 * /tasks
 */
bot.command("tasks", async ctx => {
  try {
    const tasks = await getPendingTasks(ctx.from.id);

    if (!tasks.length) {
      return ctx.reply(
        "🎉 *You're all caught up!*\n\nYou don't have any pending tasks.",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const taskList = tasks
      .map((task, index) => {
        const scheduledAt = task.scheduledAt.toLocaleString("en-IN", {
          timeZone: config.timezone,
          dateStyle: "medium",
          timeStyle: "short"
        });

        return `${index + 1}. *${task.title}*\n   🕐 ${scheduledAt}`;
      })
      .join("\n\n");

    await ctx.reply(`📋 *Your pending tasks*\n\n${taskList}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error fetching tasks:", error);

    await ctx.reply(
      "Sorry, I couldn't retrieve your tasks right now. Please try again."
    );
  }
});

/**
 * /remember <text>
 */
bot.command("remember", async ctx => {
  try {
    const content = getCommandArgument(ctx.message.text, "remember");

    if (!content) {
      return ctx.reply(
        "Usage:\n\n`/remember <something to remember>`\n\nExample:\n`/remember I want to focus on System Design this month.`",
        {
          parse_mode: "Markdown"
        }
      );
    }

    await saveMemory({
      userId: ctx.from.id,
      chatId: ctx.chat.id,
      content
    });

    await ctx.reply(`🧠 *Remembered!*\n\n${content}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error saving memory:", error);

    await ctx.reply(
      "Sorry, I couldn't save that memory right now. Please try again."
    );
  }
});

/**
 * /memories
 */
bot.command("memories", async ctx => {
  try {
    const memories = await getRecentMemories(ctx.from.id);

    if (!memories.length) {
      return ctx.reply(
        "🧠 *No memories yet.*\n\nTell me something you want me to remember.",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const memoryList = memories
      .slice(0, 20)
      .map(memory => `• ${memory.content}`)
      .join("\n");

    await ctx.reply(`🧠 *Things I remember*\n\n${memoryList}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error fetching memories:", error);

    await ctx.reply(
      "Sorry, I couldn't retrieve your memories right now. Please try again."
    );
  }
});

/**
 * /done <task>
 */
bot.command("done", async ctx => {
  try {
    const taskText = getCommandArgument(ctx.message.text, "done");

    if (!taskText) {
      return ctx.reply(
        "Usage:\n\n`/done <task>`\n\nExample:\n`/done study DSA`",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const task = await completeTaskByText(ctx.from.id, taskText);

    if (!task) {
      return ctx.reply(
        `I couldn't find a pending task matching "${taskText}".`
      );
    }

    await ctx.reply(`✅ *Completed!*\n\n${task.title}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error completing task:", error);

    await ctx.reply(
      "Sorry, I couldn't complete that task right now. Please try again."
    );
  }
});

/**
 * /skip <task>
 */
bot.command("skip", async ctx => {
  try {
    const taskText = getCommandArgument(ctx.message.text, "skip");

    if (!taskText) {
      return ctx.reply(
        "Usage:\n\n`/skip <task>`\n\nExample:\n`/skip gym today`",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const task = await skipTaskByText(ctx.from.id, taskText);

    if (!task) {
      return ctx.reply(
        `I couldn't find a pending task matching "${taskText}".`
      );
    }

    await ctx.reply(`⏭️ *Skipped*\n\n${task.title}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error skipping task:", error);

    await ctx.reply(
      "Sorry, I couldn't skip that task right now. Please try again."
    );
  }
});

/**
 * /skipped
 *
 * Lists tasks currently in the "skipped" state, so the user knows
 * what title to pass to /unskip.
 */
bot.command("skipped", async ctx => {
  try {
    const tasks = await getSkippedTasks(ctx.from.id);

    if (!tasks.length) {
      return ctx.reply("You don't have any skipped tasks.");
    }

    const taskList = tasks
      .map((task, index) => {
        const skippedAt = task.skippedAt
          ? task.skippedAt.toLocaleString("en-IN", {
              timeZone: config.timezone,
              dateStyle: "medium",
              timeStyle: "short"
            })
          : "unknown time";

        return `${index + 1}. *${task.title}*\n   ⏭️ skipped ${skippedAt}`;
      })
      .join("\n\n");

    await ctx.reply(
      `⏭️ *Your skipped tasks*\n\n${taskList}\n\nUse \`/unskip <task>\` to bring one back.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error fetching skipped tasks:", error);

    await ctx.reply(
      "Sorry, I couldn't retrieve your skipped tasks right now. Please try again."
    );
  }
});

/**
 * /unskip <task>
 *
 * Restores a skipped task back to "pending" — it reappears in
 * /tasks and starts getting reminders again. If its original time
 * has already passed, it's rescheduled to right now.
 */
bot.command("unskip", async ctx => {
  try {
    const taskText = getCommandArgument(ctx.message.text, "unskip");

    if (!taskText) {
      return ctx.reply(
        "Usage:\n\n`/unskip <task>`\n\nExample:\n`/unskip gym today`\n\nTip: use /skipped to see what you can restore.",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const task = await unskipTaskByText(ctx.from.id, taskText);

    if (!task) {
      return ctx.reply(
        `I couldn't find a skipped task matching "${taskText}". Use /skipped to see your skipped tasks.`
      );
    }

    const when = task.scheduledAt.toLocaleString("en-IN", {
      timeZone: config.timezone,
      dateStyle: "medium",
      timeStyle: "short"
    });

    await ctx.reply(
      `↩️ *Restored*\n\n${task.title}\n🕐 ${when}`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error unskipping task:", error);

    await ctx.reply(
      "Sorry, I couldn't restore that task right now. Please try again."
    );
  }
});

/**
 * /delete <task>
 *
 * Permanently deletes a single pending task (unlike /skip, which
 * just marks it skipped). Previously only reachable by asking the
 * AI agent to "delete" a task — now a direct command.
 */
bot.command("delete", async ctx => {
  try {
    const taskText = getCommandArgument(ctx.message.text, "delete");

    if (!taskText) {
      return ctx.reply(
        "Usage:\n\n`/delete <task>`\n\nExample:\n`/delete gym today`",
        {
          parse_mode: "Markdown"
        }
      );
    }

    const task = await deleteTaskByText(ctx.from.id, taskText);

    if (!task) {
      return ctx.reply(
        `I couldn't find a pending task matching "${taskText}".`
      );
    }

    await ctx.reply(`🗑️ *Deleted*\n\n${task.title}`, {
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.error("Error deleting task:", error);

    await ctx.reply(
      "Sorry, I couldn't delete that task right now. Please try again."
    );
  }
});

/**
 * /cleartasks
 *
 * Permanently deletes ALL pending tasks in one go. Previously only
 * reachable by asking the AI agent to "clear all tasks" — now a
 * direct command. Requires typing "/cleartasks confirm" so it can't
 * be triggered by accident.
 */
bot.command("cleartasks", async ctx => {
  try {
    const arg = getCommandArgument(ctx.message.text, "cleartasks");

    if (arg.toLowerCase() !== "confirm") {
      return ctx.reply(
        '⚠️ This deletes *all* your pending tasks permanently.\n\nTo confirm, send:\n`/cleartasks confirm`',
        { parse_mode: "Markdown" }
      );
    }

    const deletedCount = await clearAllPendingTasks(ctx.from.id);

    await ctx.reply(
      deletedCount === 0
        ? "There were no pending tasks to clear."
        : `🗑️ Deleted ${deletedCount} pending task${deletedCount === 1 ? "" : "s"}.`
    );
  } catch (error) {
    console.error("Error clearing tasks:", error);

    await ctx.reply(
      "Sorry, I couldn't clear your tasks right now. Please try again."
    );
  }
});

/**
 * /summary
 *
 * The actual summary generation can be connected
 * to the same summary logic used by the scheduler.
 *
 * For now, ask the agent so natural-language summary
 * and /summary can share the same intelligence.
 */
bot.command("summary", async (ctx) => {
  try {
    const userId = ctx.from.id;

    const summary =
      await buildDailySummary(userId);

    await ctx.reply(summary);
  } catch (error) {
    console.error(
      "Daily summary error:",
      error
    );

    await ctx.reply(
      "Sorry, I couldn't generate today's summary."
    );
  }
});



bot.command("weekly", async (ctx) => {
  try {
    const userId = ctx.from.id;

    const analytics =
      await getWeeklyAnalytics(
        userId,
        new Date(),
        config.timezone
      );

    const trend =
      await getWeeklyTrend(
        userId,
        new Date(),
        config.timezone
      );

    let message = `📊 WEEKLY REVIEW

🎯 PERFORMANCE
• ${analytics.planned} tasks planned
• ${analytics.completed} completed
• ${analytics.skipped} skipped
• ${analytics.incomplete} incomplete

Completion rate: ${analytics.completionRate}%

━━━━━━━━━━━━━━━━

⏰ DISCIPLINE
• Completed on time: ${analytics.completedOnTime}
• Completed late: ${analytics.completedLate}
• Ignored reminders: ${analytics.ignoredReminders}
• Carried forward: ${analytics.forwarded}

━━━━━━━━━━━━━━━━

📈 DAILY TREND

`;

    for (const day of trend) {
      message += `• ${day.label}: ${day.completionRate}%\n`;
    }

    message += `
━━━━━━━━━━━━━━━━

💡 INSIGHT
`;

    if (
      analytics.completionRate >= 90
    ) {
      message +=
        "Excellent consistency this week. 🔥";
    } else if (
      analytics.completionRate >= 75
    ) {
      message +=
        "Good week. You're maintaining solid consistency. 💪";
    } else if (
      analytics.completionRate >= 50
    ) {
      message +=
        "Decent progress, but there are several tasks slipping. Try reducing the number of tasks you plan each day.";
    } else {
      message +=
        "This week was difficult. Focus on fewer, more important tasks next week.";
    }

    await ctx.reply(message);
  } catch (error) {
    console.error(
      "Weekly analytics error:",
      error
    );

    await ctx.reply(
      "Sorry, I couldn't generate your weekly analytics."
    );
  }
});

bot.command("monthly", async (ctx) => {
  try {
    const userId = ctx.from.id;

    const analytics =
      await getMonthlyAnalytics(
        userId,
        new Date(),
        config.timezone
      );

    const trend =
      await getMonthlyTrend(
        userId,
        new Date(),
        config.timezone
      );

    let message = `📅 MONTHLY REVIEW

🎯 PERFORMANCE
• ${analytics.planned} tasks planned
• ${analytics.completed} completed
• ${analytics.skipped} skipped
• ${analytics.incomplete} incomplete

Completion rate: ${analytics.completionRate}%

━━━━━━━━━━━━━━━━

⏰ DISCIPLINE
• Completed on time: ${analytics.completedOnTime}
• Completed late: ${analytics.completedLate}
• Ignored reminders: ${analytics.ignoredReminders}
• Carried forward: ${analytics.forwarded}

━━━━━━━━━━━━━━━━

📈 WEEKLY TREND

`;

    for (const week of trend) {
      message += `• ${week.label}: ${week.completionRate}%\n`;
    }

    message += `
━━━━━━━━━━━━━━━━

💡 MONTHLY INSIGHT
`;

    if (
      analytics.completionRate >= 90
    ) {
      message +=
        "Outstanding consistency this month. 🔥";
    } else if (
      analytics.completionRate >= 75
    ) {
      message +=
        "You're maintaining good consistency. Keep building the habit.";
    } else if (
      analytics.completionRate >= 50
    ) {
      message +=
        "Your consistency is mixed. Planning fewer tasks may help you complete more of them.";
    } else {
      message +=
        "Your completion rate is low this month. Focus on a smaller number of important tasks and build consistency first.";
    }

    await ctx.reply(message);
  } catch (error) {
    console.error(
      "Monthly analytics error:",
      error
    );

    await ctx.reply(
      "Sorry, I couldn't generate your monthly analytics."
    );
  }
});


/**
 * Natural language messages
 *
 * Anything that isn't a Telegram command is handled
 * by the LangGraph + Gemini agent.
 */
bot.on("text", ctx => {
  const text = ctx.message.text.trim();

  // A "/"-prefixed message reaching this handler means no
  // bot.command(...) above matched it (a matched command handles
  // its own reply and doesn't fall through here) — so this is an
  // unrecognized command. Tell the user instead of staying silent.
  if (text.startsWith("/")) {
    const commandName = text.slice(1).split(/[\s@]/)[0].toLowerCase();

    if (!knownCommands.has(commandName)) {
      const commandList = commandDefinitions
        .map(({ command, description }) => `/${command} — ${description}`)
        .join("\n");

      void ctx.reply(
        `❌ *Unknown command:* /${commandName}\n\nHere are the valid commands:\n\n${commandList}`,
        { parse_mode: "Markdown" }
      );
    }

    return;
  }

  const userId = ctx.from.id;

  // If the user is mid-way through the manual /addtask flow, treat
  // this text as flow input — never send it to the AI agent.
  const draft = taskDrafts.get(userId);

  if (draft) {
    void (async () => {
      try {
        if (draft.step === "title") {
          if (!text) {
            await ctx.reply("Title can't be empty. What's the task title?");
            return;
          }

          taskDrafts.set(userId, { step: "date", title: text });
          await ctx.reply("When is it due?", dateChoiceKeyboard());
          return;
        }

        if (draft.step === "custom_date") {
          const dateStr = parseDateInput(text);

          if (!dateStr) {
            await ctx.reply(
              "Couldn't read that date. Try DD/MM/YYYY or YYYY-MM-DD:"
            );
            return;
          }

          taskDrafts.set(userId, {
            step: "time",
            title: draft.title,
            dateStr
          });

          await ctx.reply(
            `Date: ${formatDateLabel(dateStr, config.timezone)}\n\nWhat time? (e.g. "8pm" or "20:00")`
          );
          return;
        }

        if (draft.step === "time") {
          const time = parseTimeInput(text);

          if (!time) {
            await ctx.reply(
              'Couldn\'t read that time. Try something like "8pm" or "20:00":'
            );
            return;
          }

          taskDrafts.set(userId, {
            step: "description",
            title: draft.title,
            dateStr: draft.dateStr,
            time
          });

          await ctx.reply(
            "Add a description? Send it now, or tap Skip.",
            descriptionChoiceKeyboard()
          );
          return;
        }

        if (draft.step === "description") {
          taskDrafts.delete(userId);
          await finalizeTaskDraft(ctx, draft, text);
          return;
        }
      } catch (error) {
        console.error("Error in add-task flow:", error);
        taskDrafts.delete(userId);
        await ctx.reply(
          "Something went wrong creating that task. Please try /addtask again."
        );
      }
    })();

    return;
  }

  // Free text with no active flow: no AI to interpret it, so just
  // point the user at the command menu instead of trying to guess.
  void ctx.reply(
    "I don't understand plain messages anymore — please use a command instead.\n\nType /help to see what I can do, or /addtask to add a task."
  );
});

/**
 * HEALTH CHECK SERVER
 * ------------------------------------------------------------
 * This bot talks to Telegram via long polling — it never opens a
 * port on its own. Render's free "Web Service" tier expects the
 * process to bind to $PORT and will eventually mark the deploy
 * unhealthy/exit it if nothing ever does ("No open ports
 * detected"). This tiny server exists purely to satisfy that
 * check; it isn't used by Telegram, the agent, or anything else
 * in the app.
 *
 * If you move this service to a Render "Background Worker" (paid
 * plans only) instead of "Web Service", this server is no longer
 * needed and can be removed along with the call to it in main().
 */
function startHealthServer() {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });

  server.listen(port, () => {
    console.log(`Health check server listening on port ${port}`);
  });

  return server;
}

/**
 * Start application
 */
async function main() {
  // Bind a port immediately so Render's health check passes even
  // if connectDb() or bot.launch() below take a moment.
  startHealthServer();

  await connectDb();

  // Register Telegram "/" command menu.
  await setupBotCommands();

  // Start reminder and daily-summary schedulers.
  startSchedulers(bot);

  // Start Telegram bot.
  await bot.launch();

  console.log("Telegram personal assistant is running.");
}

/**
 * Application startup error
 */
main().catch(error => {
  console.error("Failed to start application:", error);
  process.exit(1);
});

/**
 * Graceful shutdown
 */
process.once("SIGINT", () => {
  console.log("Stopping bot...");
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  console.log("Stopping bot...");
  bot.stop("SIGTERM");
});