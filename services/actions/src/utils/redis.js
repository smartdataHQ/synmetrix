import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_ADDR;

let redisClient = null;

if (REDIS_URL) {
  redisClient = new Redis(REDIS_URL);
}

export default redisClient;
