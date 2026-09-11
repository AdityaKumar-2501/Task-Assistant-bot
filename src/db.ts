import { MongoClient, ObjectId } from "mongodb";
import { config } from "./config.js";

export type TaskStatus = "pending" | "completed" | "skipped";

export interface Task {
  _id?: ObjectId;

  userId: number;
  chatId: number;

  title: string;
  description?: string;

  scheduledAt: Date;

  status: TaskStatus;

  completedAt?: Date;
  skippedAt?: Date;

  reminderCount: number;
  lastRemindedAt?: Date;

  // Used when an unfinished task is moved to another day
  forwardedFrom?: Date;
  forwardCount?: number;

  createdAt: Date;
}

export interface ReminderEvent {
  _id?: ObjectId;

  taskId: ObjectId;

  userId: number;
  chatId: number;

  sentAt: Date;

  respondedAt?: Date;

  response?: "completed" | "skipped" | "snoozed";
}

export interface Memory {
  _id?: ObjectId;

  userId: number;
  chatId: number;

  content: string;

  createdAt: Date;
}

const client = new MongoClient(config.mongoUri);

export async function connectDb() {
  await client.connect();

  const database = client.db(config.mongoDb);

  // TASK INDEXES

  await database.collection<Task>("tasks").createIndex({
    userId: 1,
    status: 1,
    scheduledAt: 1,
  });

  await database.collection<Task>("tasks").createIndex({
    userId: 1,
    status: 1,
    title: 1,
  });

  await database.collection<Task>("tasks").createIndex({
    userId: 1,
    createdAt: 1,
  });

  // REMINDER INDEXES

  await database.collection<ReminderEvent>("reminders").createIndex({
    userId: 1,
    sentAt: 1,
  });

  await database.collection<ReminderEvent>("reminders").createIndex({
    taskId: 1,
    sentAt: 1,
  });

  // MEMORY INDEX

  await database.collection<Memory>("memories").createIndex({
    userId: 1,
    createdAt: -1,
  });

  console.log("MongoDB connected");
}

export function db() {
  return client.db(config.mongoDb);
}

export { ObjectId };