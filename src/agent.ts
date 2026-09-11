import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

import { config } from "./config.js";

import {
  getDailyAnalytics,
  getWeeklyAnalytics,
  getMonthlyAnalytics,
  getWeeklyTrend,
  getMonthlyTrend,
} from "./analytics.js";

import {
  createTask,
  getPendingTasks,
  completeTaskByText,
  skipTaskByText,
} from "./tasks.js";

import type { Task } from "./db.js";

import {
  saveMemory,
  getRecentMemories,
} from "./memories.js";


/**
 * Gemini model
 */
const model = new ChatGoogleGenerativeAI({
  model: config.geminiModel,
  apiKey: config.geminiApiKey,
  temperature: 0,
  maxOutputTokens: 300,
});

/**
 * Extract final text response from LangGraph result
 */
function extractText(result: any): string {
  const messages = result?.messages ?? [];
  const last = messages[messages.length - 1];

  if (!last) {
    return "Done.";
  }

  const content = last.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item: any) => {
        if (typeof item === "string") {
          return item;
        }

        return item?.text ?? "";
      })
      .join("");
  }

  return "Done.";
}

/**
 * ----------------------------------------------------------------
 * DATA ISOLATION FIX
 * ----------------------------------------------------------------
 * Previously, `userId` (and `chatId`) were part of each tool's Zod
 * schema, meaning Gemini generated those values itself on every
 * tool call. The system prompt told the model the real user id as
 * plain text, but nothing stopped the model from being talked into
 * using a different one (classic prompt-injection -> cross-user
 * data leak/write).
 *
 * Fix: build the tool set per incoming message, with userId/chatId
 * captured via closure from the trusted Telegram context
 * (ctx.from.id / ctx.chat.id). The identity is no longer a
 * model-controlled argument anywhere in the tool schemas.
 * ----------------------------------------------------------------
 */
function buildTools(userId: number, chatId: number) {
  const dailyAnalytics = tool(
    async () => {
      const analytics = await getDailyAnalytics(
        userId,
        new Date(),
        config.timezone
      );

      return JSON.stringify({
        planned: analytics.planned,
        completed: analytics.completed,
        skipped: analytics.skipped,
        incomplete: analytics.incomplete,
        completionRate: analytics.completionRate,
        completedOnTime: analytics.completedOnTime,
        completedLate: analytics.completedLate,
        ignoredReminders: analytics.ignoredReminders,
        forwarded: analytics.forwarded,
      });
    },
    {
      name: "daily_analytics",
      description: "Get the user's productivity analytics for today.",
      schema: z.object({}),
    }
  );

  const weeklyAnalytics = tool(
    async () => {
      const analytics = await getWeeklyAnalytics(
        userId,
        new Date(),
        config.timezone
      );

      const trend = await getWeeklyTrend(
        userId,
        new Date(),
        config.timezone
      );

      return JSON.stringify({
        planned: analytics.planned,
        completed: analytics.completed,
        skipped: analytics.skipped,
        incomplete: analytics.incomplete,
        completionRate: analytics.completionRate,
        completedOnTime: analytics.completedOnTime,
        completedLate: analytics.completedLate,
        ignoredReminders: analytics.ignoredReminders,
        forwarded: analytics.forwarded,
        trend,
      });
    },
    {
      name: "weekly_analytics",
      description:
        "Get the user's productivity analytics for the current week, including daily completion trend.",
      schema: z.object({}),
    }
  );

  const monthlyAnalytics = tool(
    async () => {
      const analytics = await getMonthlyAnalytics(
        userId,
        new Date(),
        config.timezone
      );

      const trend = await getMonthlyTrend(
        userId,
        new Date(),
        config.timezone
      );

      return JSON.stringify({
        planned: analytics.planned,
        completed: analytics.completed,
        skipped: analytics.skipped,
        incomplete: analytics.incomplete,
        completionRate: analytics.completionRate,
        completedOnTime: analytics.completedOnTime,
        completedLate: analytics.completedLate,
        ignoredReminders: analytics.ignoredReminders,
        forwarded: analytics.forwarded,
        trend,
      });
    },
    {
      name: "monthly_analytics",
      description:
        "Get the user's productivity analytics for the current month, including weekly completion trend.",
      schema: z.object({}),
    }
  );

  const listTasks = tool(
    async () => {
      const tasks = await getPendingTasks(userId);

      if (!tasks.length) {
        return "No pending tasks.";
      }

      return tasks
        .map(
          (task: Task, index: number) =>
            `${index + 1}. ${task.title} | id=${task._id?.toHexString()} | scheduled=${task.scheduledAt.toISOString()} | reminders=${task.reminderCount}`
        )
        .join("\n");
    },
    {
      name: "list_tasks",
      description: "Get all pending tasks belonging to the current user.",
      schema: z.object({}),
    }
  );

  const addTask = tool(
    async ({
      title,
      scheduledAt,
      description,
    }: {
      title: string;
      scheduledAt: string;
      description?: string;
    }) => {
      const task = await createTask({
        userId,
        chatId,
        title,
        scheduledAt,
        description,
      });

      return `Created task "${task.title}" for ${task.scheduledAt.toISOString()}.`;
    },
    {
      name: "add_task",
      description:
        "Create a new task. scheduledAt must be a full ISO-8601 timestamp including the timezone offset. User timezone is Asia/Kolkata.",
      schema: z.object({
        title: z.string(),
        scheduledAt: z.string(),
        description: z.string().optional(),
      }),
    }
  );

  const completeTask = tool(
    async ({ taskText }: { taskText: string }) => {
      const task = await completeTaskByText(userId, taskText);

      if (!task) {
        return `Could not find a pending task matching "${taskText}".`;
      }

      return `Completed "${task.title}".`;
    },
    {
      name: "complete_task",
      description:
        "Mark a pending task as completed using its title or a distinctive part of its title.",
      schema: z.object({
        taskText: z.string(),
      }),
    }
  );

  const skipTask = tool(
    async ({ taskText }: { taskText: string }) => {
      const task = await skipTaskByText(userId, taskText);

      if (!task) {
        return `Could not find a pending task matching "${taskText}".`;
      }

      return `Skipped "${task.title}".`;
    },
    {
      name: "skip_task",
      description:
        "Skip a pending task using its title or a distinctive part of its title.",
      schema: z.object({
        taskText: z.string(),
      }),
    }
  );

  const remember = tool(
    async ({ content }: { content: string }) => {
      await saveMemory({
        userId,
        chatId,
        content,
      });

      return `Remembered: ${content}`;
    },
    {
      name: "remember",
      description:
        "Save something that the user explicitly asks the assistant to remember.",
      schema: z.object({
        content: z.string(),
      }),
    }
  );

  const memories = tool(
    async () => {
      const items = await getRecentMemories(userId);

      if (!items.length) {
        return "No saved memories.";
      }

      return items
        .map((memory: { content: string }) => `- ${memory.content}`)
        .join("\n");
    },
    {
      name: "get_memories",
      description:
        "Get things the user previously asked the assistant to remember.",
      schema: z.object({}),
    }
  );

  return [
    listTasks,
    addTask,
    completeTask,
    skipTask,
    remember,
    memories,
    dailyAnalytics,
    weeklyAnalytics,
    monthlyAnalytics,
  ];
}

/**
 * fastResponses
 *
 * These messages don't need Gemini.
 */
const fastResponses = new Map<string, string>([
  ["hi", "👋 Hey! How can I help?"],
  ["hello", "👋 Hey! How can I help?"],
  ["hey", "👋 Hey! How can I help?"],
  ["thanks", "You're welcome! 😊"],
  ["thank you", "You're welcome! 😊"],
  ["good morning", "🌅 Good morning! What are we getting done today?"],
  ["good night", "🌙 Good night!"],
]);

/**
 * HANDLE USER MESSAGE
 */
export async function handleUserMessage(input: {
  userId: number;
  chatId: number;
  message: string;
}) {
  const text = input.message.trim();
  const normalized = text.toLowerCase();

  /**
   * Fast path
   */
  const fastResponse = fastResponses.get(normalized);

  if (fastResponse) {
    return fastResponse;
  }

  const startTime = Date.now();

  const currentTime = new Date().toISOString();

  // Build a fresh agent per message, with userId/chatId bound via
  // closure — the LLM never sees or sets these itself.
  const assistant = createAgent({
    model,
    tools: buildTools(input.userId, input.chatId),
  });

  const system = `
You are a personal productivity assistant inside Telegram.

USER
User ID: ${input.userId}
Chat ID: ${input.chatId}

Current time:
${currentTime}

Timezone:
${config.timezone}

RULES

1. Tasks
- Create tasks with add_task.
- Always convert time to a full ISO-8601 timestamp.
- Never guess a time.
- If no time is provided when creating a task, ask for the time.

2. Completing
- "done DSA", "finished DSA", "completed DSA" -> complete_task.
- If user says only "done" and exactly one obvious pending task exists, complete it.
- If multiple tasks could match, ask which one.

3. Skipping
- "skip DSA" -> skip_task.

4. Memories
- Only use remember when the user explicitly asks you to remember something.
- Use get_memories when the user asks what you remember.

5. Tasks lookup
- Use list_tasks when the user asks about pending/planned tasks.

6. Responses
- Keep responses short.
- Be conversational.
- Use emojis when useful.
- Never claim a task was created/completed/skipped or something was remembered unless the tool succeeded.
- Never explain internal tools or LangGraph.

ANALYTICS
---------

If the user asks about today's performance:

Examples:
"How did I do today?"
"Show today's summary"
"What did I accomplish today?"
"How was my day?"

Use daily_analytics.

If the user asks about their week:

Examples:
"How did I do this week?"
"Show my weekly performance"
"Am I improving this week?"
"How productive was I this week?"

Use weekly_analytics.

If the user asks about their month:

Examples:
"How did I do this month?"
"Show my monthly analytics"
"How productive was I this month?"
"Am I improving?"

Use monthly_analytics.

When presenting analytics:

- Keep the response concise.
- Show planned, completed, skipped and incomplete tasks.
- Show completion percentage.
- Show late completions.
- Show ignored reminders.
- Show forwarded tasks.
- For weekly analytics, show the daily trend.
- For monthly analytics, show the weekly trend.
- Give ONE useful insight based on the actual numbers.
- Never invent statistics.
`;

  try {
    const result = await assistant.invoke({
      messages: [
        {
          role: "system",
          content: system,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const response = extractText(result);

    console.log(`[AGENT] ${Date.now() - startTime}ms | "${text}"`);

    return response;
  } catch (error) {
    console.error("LangGraph agent error:", error);

    return "Sorry, I couldn't process that right now.";
  }
}