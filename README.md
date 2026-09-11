# Telegram Personal Assistant

A simple personal productivity assistant running inside Telegram.

## Features

- Natural-language task creation
- Scheduled Telegram reminders
- Complete tasks with "done"
- Skip tasks
- Snooze can be added next
- Persistent memory/notes
- Reminder count / accountability tracking
- Nightly daily review
- LangGraph agent for natural-language understanding
- MongoDB persistence

## Architecture

Telegram -> Telegraf -> Node.js/TypeScript -> LangGraph Agent -> Tools -> MongoDB

A background scheduler checks due tasks every minute and sends reminders.

## 1. Requirements

- Node.js 20+
- MongoDB local OR MongoDB Atlas
- Telegram account
- Telegram bot token
- OpenAI API key

MongoDB Atlas has a free deployment option according to MongoDB's official documentation.

## 2. Create Telegram bot

Open Telegram and talk to `@BotFather`.

Run:

/newbot

Choose a name and username. BotFather gives you a token.

Put it in `.env` as:

TELEGRAM_BOT_TOKEN=...

## 3. Create environment file

Copy:

cp .env.example .env

Then fill:

TELEGRAM_BOT_TOKEN=...
OPENAI_API_KEY=...
MONGODB_URI=...
MONGODB_DB=personal_assistant

The default timezone is:

TIMEZONE=Asia/Kolkata

## 4. Install

npm install

## 5. Run in development

npm run dev

## 6. Test

Open your Telegram bot and send:

/start

Then:

Remind me tomorrow at 8 AM to revise binary search

Then:

What tasks do I have?

Then:

done binary search

Then:

Remember that I need to research system design resources.

Then:

What did I ask you to remember?

## Commands

/start
/tasks
/done <task>
/skip <task>
/remember <note>
/memories

Natural language is also supported.

## Important MVP behavior

A pending task is not deleted when completed. It is marked `completed`.

This is intentional because the history is needed for:

- ignored reminder count
- late completion
- daily review
- future weekly statistics

## Reminder behavior

Once a task becomes due, the scheduler sends a reminder.

If it remains pending, another reminder is sent after REMINDER_INTERVAL_MINUTES.

The task's reminderCount tracks how many reminders were sent.

## Next improvements

1. Add reliable snooze tool.
2. Persist daily-summary delivery so restarts cannot duplicate it.
3. Add recurring tasks.
4. Add weekly reports.
5. Add task priorities.
6. Add user settings.
7. Add a small Next.js dashboard.
8. Deploy with a persistent worker.
