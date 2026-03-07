import redisClient from "./redis.js";

const SESSION_TTL = 86400; // 24 hours in seconds

export async function createSession(sessionId, data) {
  await redisClient.setex(
    `session:${sessionId}`,
    SESSION_TTL,
    JSON.stringify(data)
  );
}

export async function getSession(sessionId) {
  const data = await redisClient.get(`session:${sessionId}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function deleteSession(sessionId) {
  await redisClient.del(`session:${sessionId}`);
}

export async function extendSession(sessionId) {
  await redisClient.expire(`session:${sessionId}`, SESSION_TTL);
}

export async function updateSession(sessionId, data) {
  const ttl = await redisClient.ttl(`session:${sessionId}`);
  if (ttl > 0) {
    await redisClient.setex(
      `session:${sessionId}`,
      ttl,
      JSON.stringify(data)
    );
  }
}
