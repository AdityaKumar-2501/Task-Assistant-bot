import { db, Task } from "./db.js";
import { countIgnoredReminders } from "./tasks.js";

export interface AnalyticsPeriod {
  start: Date;
  end: Date;
}

export interface AnalyticsResult {
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

/**
 * Get local day boundaries for a timezone.
 *
 * The project currently uses Asia/Kolkata.
 */
function getDateParts(
  date: Date,
  timezone: string
) {
  const formatter = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  );

  const parts = formatter.formatToParts(date);

  const result: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
  };
}

/**
 * Convert a local date into UTC boundaries.
 *
 * This project uses Asia/Kolkata, which has no DST.
 */
export function getDayRange(
  date: Date,
  timezone = "Asia/Kolkata"
): AnalyticsPeriod {
  const {
    year,
    month,
    day,
  } = getDateParts(date, timezone);

  const start = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      0,
      0,
      0,
      0
    )
  );

  // Asia/Kolkata = UTC+5:30
  start.setTime(
    start.getTime() - 5.5 * 60 * 60 * 1000
  );

  const end = new Date(
    start.getTime() + 24 * 60 * 60 * 1000
  );

  return {
    start,
    end,
  };
}

export function getPreviousDayRange(
  date: Date,
  timezone = "Asia/Kolkata"
): AnalyticsPeriod {
  const current = getDayRange(date, timezone);

  return {
    start: new Date(
      current.start.getTime() -
        24 * 60 * 60 * 1000
    ),

    end: current.start,
  };
}

export function getWeekRange(
  date: Date,
  timezone = "Asia/Kolkata"
): AnalyticsPeriod {
  const day = getDayRange(date, timezone);

  const localDate = new Date(
    day.start.getTime() +
      5.5 * 60 * 60 * 1000
  );

  const dayOfWeek = localDate.getUTCDay();

  // Monday = 0
  const daysSinceMonday =
    dayOfWeek === 0
      ? 6
      : dayOfWeek - 1;

  const start = new Date(
    day.start.getTime() -
      daysSinceMonday * 24 * 60 * 60 * 1000
  );

  const end = new Date(
    start.getTime() +
      7 * 24 * 60 * 60 * 1000
  );

  return {
    start,
    end,
  };
}

export function getMonthRange(
  date: Date,
  timezone = "Asia/Kolkata"
): AnalyticsPeriod {
  const {
    year,
    month,
  } = getDateParts(date, timezone);

  const firstDay = new Date(
    Date.UTC(
      year,
      month - 1,
      1
    )
  );

  firstDay.setTime(
    firstDay.getTime() -
      5.5 * 60 * 60 * 1000
  );

  const nextMonth = new Date(
    Date.UTC(
      month === 12 ? year + 1 : year,
      month === 12 ? 0 : month,
      1
    )
  );

  nextMonth.setTime(
    nextMonth.getTime() -
      5.5 * 60 * 60 * 1000
  );

  return {
    start: firstDay,
    end: nextMonth,
  };
}

/**
 * Calculate analytics for any period.
 */
export async function getAnalytics(
  userId: number,
  period: AnalyticsPeriod,
  timezone = "Asia/Kolkata"
): Promise<AnalyticsResult> {
  const tasks = await db()
    .collection<Task>("tasks")
    .find({
      userId,

      createdAt: {
        $lt: period.end,
      },

      $or: [
        {
          scheduledAt: {
            $gte: period.start,
            $lt: period.end,
          },
        },

        {
          completedAt: {
            $gte: period.start,
            $lt: period.end,
          },
        },

        {
          skippedAt: {
            $gte: period.start,
            $lt: period.end,
          },
        },

        {
          forwardedFrom: {
            $gte: period.start,
            $lt: period.end,
          },
        },
      ],
    })
    .sort({
      scheduledAt: 1,
    })
    .toArray();

  const plannedTasks = tasks.filter(
    (task) =>
      task.scheduledAt >= period.start &&
      task.scheduledAt < period.end
  );

  const completedTasks = tasks.filter(
    (task) =>
      task.status === "completed" &&
      task.completedAt &&
      task.completedAt >= period.start &&
      task.completedAt < period.end
  );

  const skippedTasks = tasks.filter(
    (task) =>
      task.status === "skipped" &&
      task.skippedAt &&
      task.skippedAt >= period.start &&
      task.skippedAt < period.end
  );

  const incompleteTasks = plannedTasks.filter(
    (task) =>
      task.status === "pending"
  );

  const completedOnTime = completedTasks.filter(
    (task) =>
      task.completedAt &&
      task.completedAt <= task.scheduledAt
  ).length;

  const completedLate =
    completedTasks.length -
    completedOnTime;

  const forwarded = tasks.filter(
    (task) =>
      task.forwardedFrom &&
      task.forwardedFrom >= period.start &&
      task.forwardedFrom < period.end
  ).length;

  const ignoredReminders =
    await countIgnoredReminders(
      userId,
      period.start,
      period.end
    );

  const completionRate =
    plannedTasks.length === 0
      ? 0
      : Math.round(
          (completedTasks.length /
            plannedTasks.length) *
            100
        );

  return {
    planned: plannedTasks.length,

    completed: completedTasks.length,

    skipped: skippedTasks.length,

    incomplete: incompleteTasks.length,

    completionRate,

    completedOnTime,

    completedLate,

    ignoredReminders,

    forwarded,

    tasks,
  };
}

/**
 * Daily analytics.
 */
export async function getDailyAnalytics(
  userId: number,
  date = new Date(),
  timezone = "Asia/Kolkata"
) {
  return getAnalytics(
    userId,
    getDayRange(date, timezone),
    timezone
  );
}

/**
 * Weekly analytics.
 */
export async function getWeeklyAnalytics(
  userId: number,
  date = new Date(),
  timezone = "Asia/Kolkata"
) {
  return getAnalytics(
    userId,
    getWeekRange(date, timezone),
    timezone
  );
}

/**
 * Monthly analytics.
 */
export async function getMonthlyAnalytics(
  userId: number,
  date = new Date(),
  timezone = "Asia/Kolkata"
) {
  return getAnalytics(
    userId,
    getMonthRange(date, timezone),
    timezone
  );
}

/**
 * Get daily completion rates for a week.
 */
export async function getWeeklyTrend(
  userId: number,
  date = new Date(),
  timezone = "Asia/Kolkata"
) {
  const week = getWeekRange(
    date,
    timezone
  );

  const result: {
    label: string;
    completionRate: number;
  }[] = [];

  for (
    let i = 0;
    i < 7;
    i++
  ) {
    const start = new Date(
      week.start.getTime() +
        i * 24 * 60 * 60 * 1000
    );

    const end = new Date(
      start.getTime() +
        24 * 60 * 60 * 1000
    );

    const analytics =
      await getAnalytics(
        userId,
        {
          start,
          end,
        },
        timezone
      );

    const dateFormatter =
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone: timezone,
          weekday: "short",
        }
      );

    result.push({
      label: dateFormatter.format(
        start
      ),

      completionRate:
        analytics.completionRate,
    });
  }

  return result;
}

/**
 * Get weekly completion rates for a month.
 */
export async function getMonthlyTrend(
  userId: number,
  date = new Date(),
  timezone = "Asia/Kolkata"
) {
  const month = getMonthRange(
    date,
    timezone
  );

  const result: {
    label: string;
    completionRate: number;
  }[] = [];

  let current = month.start;
  let weekNumber = 1;

  while (
    current < month.end
  ) {
    const next = new Date(
      Math.min(
        current.getTime() +
          7 * 24 * 60 * 60 * 1000,
        month.end.getTime()
      )
    );

    const analytics =
      await getAnalytics(
        userId,
        {
          start: current,
          end: next,
        },
        timezone
      );

    result.push({
      label: `Week ${weekNumber}`,

      completionRate:
        analytics.completionRate,
    });

    current = next;
    weekNumber++;
  }

  return result;
}