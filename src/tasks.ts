import { ObjectId } from "mongodb";
import { db, Task } from "./db.js";

export async function createTask(input: {
  userId: number;
  chatId: number;
  title: string;
  scheduledAt: string;
  description?: string;
}) {
  const scheduledAt = new Date(input.scheduledAt);

  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("Invalid scheduledAt");
  }

  const task: Task = {
    userId: input.userId,
    chatId: input.chatId,
    title: input.title,
    description: input.description,
    scheduledAt,
    status: "pending",

    completedAt: undefined,
    skippedAt: undefined,

    reminderCount: 0,

    forwardedFrom: undefined,
    forwardCount: 0,

    createdAt: new Date(),
  };

  const result = await db()
    .collection<Task>("tasks")
    .insertOne(task);

  return {
    ...task,
    _id: result.insertedId,
  };
}

export async function getPendingTasks(userId: number) {
  return db()
    .collection<Task>("tasks")
    .find({
      userId,
      status: "pending",
    })
    .sort({
      scheduledAt: 1,
    })
    .toArray();
}

export async function completeTask(
  userId: number,
  taskId: string
) {
  const _id = new ObjectId(taskId);

  return db()
    .collection<Task>("tasks")
    .findOneAndUpdate(
      {
        _id,
        userId,
        status: "pending",
      },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
        },
      },
      {
        returnDocument: "after",
      }
    );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function findBestTaskForCompletion(
  userId: number,
  text: string
) {
  const q = text.toLowerCase().trim();

  if (!q) {
    return null;
  }

  const regex = escapeRegex(q);

  const tasks = await db()
    .collection<Task>("tasks")
    .find({
      userId,
      status: "pending",

      $or: [
        {
          title: {
            $regex: `^${regex}$`,
            $options: "i",
          },
        },
        {
          title: {
            $regex: regex,
            $options: "i",
          },
        },
      ],
    })
    .sort({
      scheduledAt: 1,
    })
    .limit(10)
    .toArray();

  if (!tasks.length) {
    return null;
  }

  const exactMatch = tasks.find(
    (task) => task.title.toLowerCase() === q
  );

  return exactMatch ?? tasks[0];
}

export async function completeTaskByText(
  userId: number,
  text: string
) {
  const task = await findBestTaskForCompletion(
    userId,
    text
  );

  if (!task?._id) {
    return null;
  }

  return completeTask(
    userId,
    task._id.toHexString()
  );
}

export async function skipTaskByText(
  userId: number,
  text: string
) {
  const task = await findBestTaskForCompletion(
    userId,
    text
  );

  if (!task?._id) {
    return null;
  }

  return db()
    .collection<Task>("tasks")
    .findOneAndUpdate(
      {
        _id: task._id,
        userId,
        status: "pending",
      },
      {
        $set: {
          status: "skipped",
          skippedAt: new Date(),
        },
      },
      {
        returnDocument: "after",
      }
    );
}

export async function snoozeTask(
  userId: number,
  taskId: string,
  minutes: number
) {
  return db()
    .collection<Task>("tasks")
    .findOneAndUpdate(
      {
        _id: new ObjectId(taskId),
        userId,
        status: "pending",
      },
      {
        $set: {
          scheduledAt: new Date(
            Date.now() + minutes * 60_000
          ),
        },
      },
      {
        returnDocument: "after",
      }
    );
}

export async function getDueTasks(
  now = new Date()
) {
  return db()
    .collection<Task>("tasks")
    .find({
      status: "pending",
      scheduledAt: {
        $lte: now,
      },
    })
    .toArray();
}

export async function markReminderSent(
  taskId: ObjectId
) {
  const now = new Date();

  await db()
    .collection<Task>("tasks")
    .updateOne(
      {
        _id: taskId,
      },
      {
        $inc: {
          reminderCount: 1,
        },
        $set: {
          lastRemindedAt: now,
        },
      }
    );

  const task = await db()
    .collection<Task>("tasks")
    .findOne({
      _id: taskId,
    });

  if (!task) {
    return;
  }

  await db()
    .collection("reminders")
    .insertOne({
      taskId,
      userId: task.userId,
      chatId: task.chatId,
      sentAt: now,
    });
}

/**
 * Get tasks that were relevant during a date range.
 *
 * A task is included if:
 * - it was scheduled during the period
 * - OR completed during the period
 * - OR skipped during the period
 */
export async function getTasksForDailySummary(
  userId: number,
  start: Date,
  end: Date
) {
  return db()
    .collection<Task>("tasks")
    .find({
      userId,

      createdAt: {
        $lt: end,
      },

      $or: [
        {
          scheduledAt: {
            $gte: start,
            $lt: end,
          },
        },

        {
          completedAt: {
            $gte: start,
            $lt: end,
          },
        },

        {
          skippedAt: {
            $gte: start,
            $lt: end,
          },
        },

        {
          forwardedFrom: {
            $gte: start,
            $lt: end,
          },
        },
      ],
    })
    .sort({
      scheduledAt: 1,
    })
    .toArray();
}

export async function countIgnoredReminders(
  userId: number,
  start: Date,
  end: Date
) {
  return db()
    .collection("reminders")
    .countDocuments({
      userId,

      sentAt: {
        $gte: start,
        $lt: end,
      },

      respondedAt: {
        $exists: false,
      },
    });
}