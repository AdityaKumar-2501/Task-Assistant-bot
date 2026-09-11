import { db, Memory } from "./db.js";

export async function saveMemory(input: {
  userId: number;
  chatId: number;
  content: string;
}) {
  const memory: Memory = {
    ...input,
    createdAt: new Date()
  };
  await db().collection<Memory>("memories").insertOne(memory);
  return memory;
}

export async function getRecentMemories(userId: number, limit = 20) {
  return db().collection<Memory>("memories")
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}
