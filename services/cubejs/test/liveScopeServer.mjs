import express from "express";
import routes from "../src/routes/index.js";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("An explicit unprivileged PORT is required");
}
const app = express();
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path !== "/api/v1/scope") {
    res.sendStatus(404);
    return;
  }
  next();
});
app.use(routes({ basePath: "/api" }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: "Scope resolution failed" });
});
const server = app.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, port, pid: process.pid }));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
