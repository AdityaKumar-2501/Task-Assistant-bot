# Telegram Personal Assistant API and Project Context

> **Single source of truth for AI and maintainers.**
>
> This document describes the behavior that is implemented in the current source code. When a code change affects commands, natural-language behavior, configuration, data models, database queries, scheduler behavior, integrations, or operational requirements, update this file in the same change. Do not document planned behavior as implemented behavior.

## 1. Project Identity

- **Name:** Telegram Personal Assistant
- **Runtime:** Node.js 20+ with TypeScript and ES modules
- **Entry point:** `src/index.ts`
- **Transport:** Telegram Bot API through Telegraf
- **AI runtime:** LangChain/LangGraph with Google Gemini through `@langchain/google-genai`
- **Persistence:** MongoDB
- **Analytics:** Daily, weekly, and monthly productivity calculations in `src/analytics.ts`
- **Background work:** `node-cron`, running in the same process as the Telegram bot
- **HTTP API:** None. The public API is the Telegram bot interface. TypeScript functions and LangGraph tools are internal APIs.

## 2. Runtime Flow

```text
Telegram user
    |
    v
Telegraf handlers in src/index.ts
    |-- explicit commands -> task/memory functions -> MongoDB
    |
    `-- ordinary text -> handleUserMessage()
                         -> LangGraph agent
                         -> per-message tools with trusted user/chat identity
                         -> task/memory functions -> MongoDB

The same process also runs two every-minute cron jobs:
    1. due-task reminder worker -> Telegram message
    2. daily-review worker at configured local time -> Telegram message
```

Business-critical task and memory mutations happen in application functions, not directly in model-generated text. Ordinary messages are queued per user so that one user's messages are processed in order; different users can be processed concurrently.

## 3. Startup and Shutdown

`src/index.ts` performs these operations in order:

1. Construct a Telegraf bot using `TELEGRAM_BOT_TOKEN`.
2. Connect to MongoDB with `connectDb()`.
3. Create the reminder and daily-summary schedulers with `startSchedulers(bot)`.
4. Register Telegram's command menu with `setMyCommands()`.
5. Start Telegram long polling with `bot.launch()`.
6. Stop the bot on `SIGINT` and `SIGTERM`.

A startup failure is logged and exits the process with status 1. `connectDb()` creates indexes every time the process starts; MongoDB makes this idempotent.

## 4. Configuration Contract

The implementation reads environment variables in `src/config.ts` after loading `.env` through `dotenv`.

| Variable                    | Required | Default                     | Meaning                                         |
| --------------------------- | -------: | --------------------------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`        |      Yes | none                        | Telegram bot token                              |
| `GEMINI_API_KEY`            |      Yes | none                        | Google Gemini API key                           |
| `GEMINI_MODEL`              |       No | `gemini-2.5-flash`          | Gemini model name                               |
| `MONGODB_URI`               |       No | `mongodb://127.0.0.1:27017` | MongoDB connection URI                          |
| `MONGODB_DB`                |       No | `personal_assistant`        | MongoDB database name                           |
| `TIMEZONE`                  |       No | `Asia/Kolkata`              | Scheduler and display timezone                  |
| `REMINDER_INTERVAL_MINUTES` |       No | `30`                        | Minimum interval between reminders for one task |
| `DAILY_SUMMARY_HOUR`        |       No | `23`                        | Daily review hour in `TIMEZONE`                 |
| `DAILY_SUMMARY_MINUTE`      |       No | `30`                        | Daily review minute in `TIMEZONE`               |

Numeric values are converted with `Number()` and are not range-validated. Invalid numeric environment values can therefore produce invalid scheduling behavior.

The checked-in `.env.example` must stay aligned with this table. In particular, the implementation uses Gemini variables, not OpenAI variables.

## 5. Data Model

All timestamps are stored as JavaScript `Date` values and therefore persist in MongoDB as BSON dates. Telegram user IDs and chat IDs are numeric values.

### Task (`tasks` collection)

```ts
interface Task {
  _id?: ObjectId;
  userId: number;
  chatId: number;
  title: string;
  description?: string;
  scheduledAt: Date;
  status: "pending" | "completed" | "skipped";
  completedAt?: Date;
  skippedAt?: Date;
  reminderCount: number;
  lastRemindedAt?: Date;
  forwardedFrom?: Date;
  forwardCount?: number;
  createdAt: Date;
}
```

Rules:

- New tasks always start as `pending` with `reminderCount: 0`.
- Completing a task sets `status: "completed"` and `completedAt`; it does not delete the task.
- Skipping a task sets `status: "skipped"` and `skippedAt`; it does not set `completedAt`.
- `forwardedFrom` and `forwardCount` support unfinished-task carry-forward data, although no current Telegram handler performs a forward operation.
- Only pending tasks can be completed, skipped, or snoozed.
- Task matching by text is case-insensitive and uses exact title matching first, then substring matching in either direction.
- Matching is scoped by `userId`, but task listing is sorted by `scheduledAt` ascending.

### Reminder event (`reminders` collection)

```ts
interface ReminderEvent {
  _id?: ObjectId;
  taskId: ObjectId;
  userId: number;
  chatId: number;
  sentAt: Date;
  respondedAt?: Date;
  response?: "completed" | "skipped" | "snoozed";
}
```

A reminder event is inserted after a reminder message is successfully sent and the task reminder counter is incremented. The current code does not update `respondedAt` or `response` when a user completes or skips a task, so unanswered-reminder counts currently remain based on the absence of those fields.

### Memory (`memories` collection)

```ts
interface Memory {
  _id?: ObjectId;
  userId: number;
  chatId: number;
  content: string;
  createdAt: Date;
}
```

Memories are append-only. Reads return the newest records first and default to 20 records.

## 6. MongoDB Contract

`connectDb()` creates these indexes:

- `tasks`: `{ userId: 1, status: 1, scheduledAt: 1 }`
- `tasks`: `{ userId: 1, status: 1, title: 1 }`
- `tasks`: `{ userId: 1, createdAt: 1 }`
- `reminders`: `{ userId: 1, sentAt: 1 }`
- `reminders`: `{ taskId: 1, sentAt: 1 }`
- `memories`: `{ userId: 1, createdAt: -1 }`

The shared database accessor is `db()` from `src/db.ts`. Collections are named `tasks`, `reminders`, and `memories`.

## 7. Telegram Public API

### `/start`

Returns a Markdown-formatted welcome message describing natural-language task management, reminders, progress, memories, and the command menu.

### `/help`

Returns Markdown-formatted usage guidance for tasks, memories, daily progress, and quick commands.

### `/tasks`

Lists all pending tasks for `ctx.from.id`, ordered by scheduled time. Each item includes its title and a localized `en-IN` medium date and short time formatted in `config.timezone`. Responses use Telegram Markdown. Database failures return a user-facing retrieval error.

### `/remember <content>`

Saves the remaining command text as a memory using the sender's user ID and chat ID. With no content, returns the usage string instead of saving.

### `/memories`

Returns up to the 20 most recent memories for the sender. With no records, reports that there are no saved memories.

### `/done <task>`

Finds a pending task by exact or partial title match for the sender and marks it completed. With no task text, returns usage. If no match exists, reports that no pending task was found.

### `/skip <task>`

Finds a pending task by exact or partial title match for the sender and marks it skipped. With no task text, returns usage. If no match exists, reports that no pending task was found.

### `/summary`

Generates today's productivity review using `getDailyAnalytics()` and sends task counts, completion rate, completed task details, unfinished tasks, skipped tasks, reminder totals, timing, carry-forward count, and a threshold-based insight. Database or analytics failures return a user-facing error.

### `/weekly`

Generates the current Monday-Sunday productivity review using `getWeeklyAnalytics()` and `getWeeklyTrend()`. It includes planned, completed, skipped, incomplete, completion rate, on-time/late completion, ignored reminders, carry-forward count, a daily percentage trend, and a threshold-based insight.

### `/monthly`

Generates the current calendar-month review using `getMonthlyAnalytics()` and `getMonthlyTrend()`. It includes the same performance and discipline metrics as the weekly review plus a weekly percentage trend and monthly insight.

### Telegram command menu

Startup calls `setMyCommands()` with: `start`, `help`, `tasks`, `done`, `skip`, `remember`, `memories`, `summary`, `weekly`, and `monthly`.

### Ordinary text messages

Non-command text is passed to `handleUserMessage({ userId, chatId, message })`. The handler sends a typing action, invokes the LangGraph agent, and replies with the extracted final model response. Messages beginning with `/` that are not handled as commands are ignored by the generic text handler.

The generic handler does not await Telegraf's update callback. It enqueues ordinary messages by `ctx.from.id`: messages from one user run serially, while different users run concurrently. Errors in the generic handler are logged and produce `Something went wrong while processing your request. Please try again.` Errors inside the agent are logged and produce `Sorry, I couldn't process that right now.`

## 8. Natural-Language Agent API

`src/agent.ts` creates a fresh LangGraph agent for each non-fast ordinary message. It uses a Gemini model configured at temperature 0 with `maxOutputTokens: 300`. The system prompt includes the current user ID, chat ID, current ISO timestamp, and configured timezone.

Short exact messages `hi`, `hello`, `hey`, `thanks`, `thank you`, `good morning`, and `good night` use local responses and do not call Gemini.

Tool identity is data-isolated: `userId` and `chatId` are captured from trusted Telegram context in closures. They are not present in any model-controlled tool schema, preventing the model from selecting another user's identity.

The agent is instructed to keep responses short, use tools for state changes, avoid claiming a mutation unless the tool succeeds, and not expose internal implementation details.

### Registered tools

| Tool                | Input schema                                                   | Behavior                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tasks`        | `{}`                                                           | Returns all pending tasks, including title, MongoDB ID, ISO scheduled time, and reminder count.                                                             |
| `add_task`          | `{ title: string, scheduledAt: string, description?: string }` | Parses `scheduledAt` as a date and inserts a pending task using trusted closure identity. Requires a complete ISO-8601 timestamp including timezone offset. |
| `complete_task`     | `{ taskText: string }`                                         | Completes a matching pending task by title text using trusted closure identity.                                                                             |
| `skip_task`         | `{ taskText: string }`                                         | Skips a matching pending task by title text using trusted closure identity.                                                                                 |
| `remember`          | `{ content: string }`                                          | Inserts a memory using trusted closure identity.                                                                                                            |
| `get_memories`      | `{}`                                                           | Returns up to 20 recent memories for the trusted user.                                                                                                      |
| `daily_analytics`   | `{}`                                                           | Returns today's productivity metrics as JSON.                                                                                                               |
| `weekly_analytics`  | `{}`                                                           | Returns current-week metrics and daily trend as JSON.                                                                                                       |
| `monthly_analytics` | `{}`                                                           | Returns current-month metrics and weekly trend as JSON.                                                                                                     |

Task creation must not guess a time. If the user does not provide a time, the agent must ask for one. The tool description says `Asia/Kolkata`, while the runtime prompt supplies `config.timezone`. Analytics requests must use the matching analytics tool and present only returned statistics.

### Model response extraction

`extractText()` reads the last message from the LangGraph result. It supports string content and array content items with a `text` property. If no usable last message exists, it returns `Done.`.

## 9. Internal TypeScript API

### `src/tasks.ts`

- `createTask(input)` validates `scheduledAt`, inserts a pending task, and returns it with the inserted `_id`.
- `getPendingTasks(userId)` returns pending tasks ordered by `scheduledAt`.
- `completeTask(userId, taskId)` updates one pending task owned by the user.
- `findBestTaskForCompletion(userId, text)` returns `null` for empty text, searches pending titles with escaped case-insensitive exact/substring regexes, sorts by `scheduledAt`, limits candidates to 10, and prefers an exact match.
- `completeTaskByText(userId, text)` resolves a task and completes it, or returns `null`.
- `skipTaskByText(userId, text)` resolves a task and skips it, setting `skippedAt`, or returns `null`.
- `snoozeTask(userId, taskId, minutes)` moves a pending task to `Date.now() + minutes * 60_000`.
- `getDueTasks(now = new Date())` returns all pending tasks with `scheduledAt <= now`.
- `markReminderSent(taskId)` increments `reminderCount`, sets `lastRemindedAt`, and inserts a reminder event.
- `getTasksForDailySummary(userId, start, end)` returns tasks created before `end` whose scheduled, completed, skipped, or forwarded timestamp falls within `[start, end)`.
- `countIgnoredReminders(userId, start, end)` counts reminder events in `[start, end)` without `respondedAt`.

### `src/memories.ts`

- `saveMemory({ userId, chatId, content })` inserts an append-only memory with `createdAt`.
- `getRecentMemories(userId, limit = 20)` returns newest memories first.

`Task`, `ReminderEvent`, and `Memory` types plus `ObjectId` are exported from `src/db.ts`.

### `src/analytics.ts`

`AnalyticsResult` contains:

```ts
interface AnalyticsResult {
  planned: number;
  completed: number;
  skipped: number;
  incomplete: number;
  completionRate: number;
  completedOnTime: number;
  completedLate: number;
  ignoredReminders: number;
  forwarded: number;
  tasks: Task[];
}
```

The analytics query includes tasks created before the period whose scheduled, completed, skipped, or forwarded timestamp falls inside `[start, end)`. Planned tasks are scheduled in the period; incomplete tasks are planned tasks still pending; completion rate is rounded completed/planned percentage and is `0` when no tasks were planned. On-time completion means `completedAt <= scheduledAt`.

Exported functions are `getDayRange`, `getPreviousDayRange`, `getWeekRange` (Monday through Sunday), `getMonthRange` (calendar month), `getAnalytics`, `getDailyAnalytics`, `getWeeklyAnalytics`, `getMonthlyAnalytics`, `getWeeklyTrend` (seven daily rates), and `getMonthlyTrend` (one rate per seven-day segment of the month).

The range helpers currently calculate boundaries using a fixed UTC+5:30 offset even though they accept a timezone argument. This is reliable for the default `Asia/Kolkata` configuration but is not fully generic for other timezones.

## 10. Reminder Worker

`startSchedulers(bot)` schedules a reminder job every minute in `config.timezone`.

For every pending task due at the current time:

1. Skip it if `lastRemindedAt` is less than `REMINDER_INTERVAL_MINUTES` ago.
2. Send a Telegram message containing the task title and instructions for `done` and `snooze` text.
3. After a successful send, call `markReminderSent()`.

A worker-level error is logged as `Reminder worker error`. A failed Telegram send does not increment the task reminder count because the database update happens after sending.

The reminder text mentions `snooze <task> by 30 minutes`, but there is currently no snooze Telegram command or agent tool. The internal `snoozeTask()` function is therefore not reachable through the current user-facing API.

## 11. Daily Review Worker

A second cron job runs every minute and sends a review only when the local hour and minute equal `DAILY_SUMMARY_HOUR` and `DAILY_SUMMARY_MINUTE` in `TIMEZONE`.

The review date range is generated by `dayRangeIST()`, which formats the current date in `config.timezone` but constructs the range using a fixed `+05:30` offset. This is correct for Asia/Kolkata but is not fully timezone-generic if `TIMEZONE` is changed.

Users are discovered from tasks that were scheduled or completed today, plus currently due tasks. The current MVP does not send a summary to a user who has only memories and no qualifying task.

Each discovered user receives the scheduler's simple review:

- completed task count
- completed-late count (`completedAt > scheduledAt`)
- remaining pending task count
- skipped task count
- unanswered reminder count
- today's memories, up to 10
- titles of still-pending tasks, when any exist

This scheduled review is separate from the richer `/summary` command, which uses `src/analytics.ts` and includes task details, timing, carry-forward information, and an insight.

The worker explicitly notes that a restart around the configured minute can send duplicate summaries. No persisted daily-summary delivery record currently prevents duplication.

## 12. Operational Commands

```text
npm install       Install dependencies
npm run dev       Run TypeScript with tsx watch mode
npm run build     Compile TypeScript to dist/
npm start         Run the compiled dist/index.js
```

Build output is written to `dist/` according to `tsconfig.json`. The application requires MongoDB to be reachable and the required Telegram and Gemini environment variables to be present before startup.

## 13. Current Limitations and Intentional Gaps

These are current facts, not promises of existing functionality:

- No REST, webhook, or dashboard API exists.
- Snooze storage logic exists, but no public handler or agent tool calls it.
- Reminder events are never marked as responded when tasks are completed, skipped, or snoozed.
- Daily-summary delivery is not persisted, so restart-time duplicates are possible.
- Daily summary and analytics timezone ranges use a fixed India offset even when `TIMEZONE` is changed.
- Recurring tasks, priorities, user settings, weekly reports, and a dashboard are not implemented.
- There is no explicit validation for empty task titles, empty memory content, malformed numeric configuration, or negative snooze minutes.
- There is no multi-user authorization layer beyond matching Telegram user IDs in task and memory queries.
- `.env.example` still contains legacy `OPENAI_API_KEY` and `OPENAI_MODEL` entries; the running implementation requires `GEMINI_API_KEY` and optionally reads `GEMINI_MODEL`.

## 14. Change Synchronization Rule

Whenever implementation changes, check this document for affected sections and update it in the same pull request or edit. At minimum, review:

- Telegram commands and reply behavior
- Natural-language examples and agent tool schemas
- Configuration variables and defaults
- TypeScript function signatures and task state transitions
- MongoDB collection fields and indexes
- Reminder and daily-review timing, message content, and user discovery
- Known limitations and operational commands

When this document conflicts with source code, source code is the immediate runtime authority; update this document to remove the conflict before treating the change as complete.
