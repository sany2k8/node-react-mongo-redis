import express from "express";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { createClient } from "redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config from environment -------------------------------------------------
// Same image is reused across the bridge / host / none networking experiments,
// only these env vars change (see the docker-compose.*.yml files).
const MONGO_HOST = process.env.MONGO_HOST || "mongo";
const MONGO_PORT = process.env.MONGO_PORT || "27017";
const MONGO_URL = `mongodb://${MONGO_HOST}:${MONGO_PORT}`;

const REDIS_HOST = process.env.REDIS_HOST || "redis";
const REDIS_PORT = process.env.REDIS_PORT || "6379";

const PORT = process.env.PORT || 3000;

// --- Mongo (lazy connect, tolerate failure so the app stays useful) --------
let mongoClient;
let itemsCollection;
async function getMongoCollection() {
  if (itemsCollection) return itemsCollection;
  mongoClient = new MongoClient(MONGO_URL, {
    serverSelectionTimeoutMS: 2000,
  });
  await mongoClient.connect();
  itemsCollection = mongoClient.db("labdb").collection("items");
  return itemsCollection;
}

// --- Redis (lazy connect, tolerate failure) --------------------------------
const redisClient = createClient({
  socket: {
    host: REDIS_HOST,
    port: Number(REDIS_PORT),
    connectTimeout: 2000,
    reconnectStrategy: () => false, // don't spam retries during the 'none' network demo
  },
});
redisClient.on("error", () => {}); // swallow, we surface errors explicitly per-request
let redisConnectAttempted = false;
async function getRedis() {
  if (!redisConnectAttempted) {
    redisConnectAttempted = true;
    try {
      await redisClient.connect();
    } catch {
      // will retry lazily on next request via redisClient.isOpen check below
    }
  }
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
}

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/", (_req, res) => {
  res.json({
    app: "node-mongo-redis",
    hostname: os.hostname(),
    endpoints: [
      "GET  /api/health",
      "GET  /api/network-info",
      "GET  /api/items",
      "POST /api/items",
      "GET  /api/items/cached",
      "GET  /api/counter",
    ],
  });
});

app.get("/api/network-info", async (_req, res) => {
  const info = {
    container_hostname: os.hostname(),
    mongo_host_configured: MONGO_HOST,
    mongo_port_configured: MONGO_PORT,
    redis_host_configured: REDIS_HOST,
    redis_port_configured: REDIS_PORT,
  };

  try {
    await getMongoCollection();
    info.mongo_reachable = true;
  } catch (err) {
    info.mongo_reachable = false;
    info.mongo_error = String(err.message || err);
  }

  try {
    const r = await getRedis();
    info.redis_reachable = await r.ping() === "PONG";
  } catch (err) {
    info.redis_reachable = false;
    info.redis_error = String(err.message || err);
  }

  res.json(info);
});

app.post("/api/items", async (req, res) => {
  try {
    const col = await getMongoCollection();
    const doc = { name: req.body.name, created_at: new Date().toISOString() };
    const result = await col.insertOne(doc);
    try {
      const r = await getRedis();
      await r.del("items:cache");
    } catch {
      /* cache invalidation best-effort */
    }
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    res.status(503).json({ error: "mongo unreachable", detail: String(err.message || err) });
  }
});

app.get("/api/items", async (_req, res) => {
  try {
    const col = await getMongoCollection();
    const items = await col.find({}).sort({ _id: -1 }).toArray();
    res.json(items);
  } catch (err) {
    res.status(503).json({ error: "mongo unreachable", detail: String(err.message || err) });
  }
});

app.get("/api/items/cached", async (_req, res) => {
  let r;
  try {
    r = await getRedis();
    const cached = await r.get("items:cache");
    if (cached) {
      return res.json({ source: "redis-cache", items: JSON.parse(cached) });
    }
  } catch {
    r = null; // fall through to mongo
  }

  try {
    const col = await getMongoCollection();
    const items = await col.find({}).sort({ _id: -1 }).toArray();
    if (r) {
      try {
        await r.set("items:cache", JSON.stringify(items), { EX: 30 });
      } catch {
        /* best effort */
      }
    }
    res.json({ source: "mongo", items });
  } catch (err) {
    res.status(503).json({ error: "mongo unreachable", detail: String(err.message || err) });
  }
});

app.get("/api/counter", async (_req, res) => {
  try {
    const r = await getRedis();
    const value = await r.incr("hit_counter");
    res.json({ source: "redis", hit_counter: value });
  } catch (err) {
    res.status(503).json({ source: "redis-unreachable", error: String(err.message || err) });
  }
});

// Serve the built React app (see frontend/Dockerfile stage that copies dist here).
const staticDir = path.join(__dirname, "..", "public");
app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`node-mongo-redis backend listening on port ${PORT}`);
});
