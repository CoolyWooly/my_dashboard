import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import si from "systeminformation";
import {
  docker,
  listContainers,
  statsAll,
  containerAction,
  inspect,
} from "./docker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Basic-авторизация. Включается, только если заданы DASH_USER и DASH_PASS.
// Без них дашборд открыт (удобно для локальной разработки).
const AUTH_USER = process.env.DASH_USER;
const AUTH_PASS = process.env.DASH_PASS;
const AUTH_ENABLED = Boolean(AUTH_USER && AUTH_PASS);

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Проверяет заголовок Authorization у любого http-запроса (REST или WS upgrade).
function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString();
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS);
}

const app = express();
app.use(express.json());

// Защищаем всё: страницу, статику, API.
app.use((req, res, next) => {
  if (isAuthorized(req)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Docker Dashboard"');
  res.status(401).send("Authentication required");
});

app.use(express.static(join(__dirname, "..", "public")));

// --- REST API ---

app.get("/api/containers", async (_req, res) => {
  try {
    res.json(await listContainers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/containers/:id", async (req, res) => {
  try {
    res.json(await inspect(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/containers/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }
  try {
    await containerAction(id, action);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await statsAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Метрики хоста (сервера).
app.get("/api/system", async (_req, res) => {
  try {
    const [cpu, mem, fs, os, load, time] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.osInfo(),
      si.cpu(),
      si.time(),
    ]);
    const rootFs = fs.find((f) => f.mount === "/") || fs[0] || {};
    res.json({
      cpu: {
        load: cpu.currentLoad,
        cores: load.cores,
        model: load.brand,
      },
      mem: {
        total: mem.total,
        used: mem.active,
        free: mem.available,
        percent: (mem.active / mem.total) * 100,
      },
      disk: {
        total: rootFs.size || 0,
        used: rootFs.used || 0,
        percent: rootFs.use || 0,
      },
      os: {
        platform: os.platform,
        distro: os.distro,
        release: os.release,
        hostname: os.hostname,
      },
      uptime: time.uptime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WebSocket: стриминг логов контейнера ---

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/api/logs",
  // Браузер отправляет тот же basic-auth заголовок при WS-рукопожатии.
  verifyClient: ({ req }, done) => {
    if (isAuthorized(req)) return done(true);
    done(false, 401, "Authentication required");
  },
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id");
  if (!id) {
    ws.send(JSON.stringify({ error: "missing container id" }));
    ws.close();
    return;
  }

  const container = docker.getContainer(id);
  let logStream = null;

  container.logs(
    {
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: false,
    },
    (err, stream) => {
      if (err) {
        ws.send(JSON.stringify({ error: err.message }));
        ws.close();
        return;
      }
      logStream = stream;
      // Docker мультиплексирует stdout/stderr с 8-байтовым заголовком на кадр.
      // Снимаем заголовок, чтобы получить чистый текст.
      stream.on("data", (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        const text = demuxDockerStream(chunk);
        if (text) ws.send(JSON.stringify({ log: text }));
      });
      stream.on("end", () => ws.readyState === ws.OPEN && ws.close());
      stream.on("error", () => ws.readyState === ws.OPEN && ws.close());
    }
  );

  ws.on("close", () => {
    if (logStream) logStream.destroy();
  });
});

// Разбирает мультиплексированный поток docker logs.
function demuxDockerStream(buffer) {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;
    out += buffer.toString("utf8", start, end);
    offset = end;
  }
  // Если заголовков нет (tty-режим), возвращаем как есть.
  return out || buffer.toString("utf8");
}

server.listen(PORT, () => {
  console.log(`Dashboard запущен на http://0.0.0.0:${PORT}`);
});
