import express from "express";
import cookieParser from "cookie-parser";

import requestId from "express-request-id";
import requestReceived from "request-received";
import responseTime from "response-time";

import hyphensToCamelCase from "./src/utils/hyphensToCamelCase.js";
import logger from "./src/utils/logger.js";
import signinHandler from "./src/auth/signin.js";
import callbackHandler from "./src/auth/callback.js";
import tokenHandler from "./src/auth/token.js";
import signoutHandler from "./src/auth/signout.js";

const port = parseInt(process.env.PORT, 10) || 3000;
const dev = process.env.NODE_ENV !== "production";
const app = express();

// adds request received hrtime and date symbols to request object
// (which is used by Cabin internally to add `request.timestamp` to logs
app.use(requestReceived);

// adds `X-Response-Time` header to responses
app.use(responseTime());

// adds or re-uses `X-Request-Id` header
app.use(requestId());

app.use(cookieParser());
app.use(express.json()); // for parsing application/json
app.use(express.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

app.use(logger.middleware);

app.get("/healthz", (req, res) => {
  return res.status(200).json({
    code: "ok",
  });
});

// Auth routes (must be before RPC catch-all)
app.get("/auth/config", (req, res) => {
  res.json({ signupEnabled: process.env.SIGNUP_ENABLED === "true" });
});
app.get("/auth/signin", signinHandler);
app.get("/auth/callback", callbackHandler);
app.get("/auth/token", tokenHandler);
app.post("/auth/signout", signoutHandler);

app.post("/rpc/:method", async (req, res) => {
  const { method } = req.params;

  const { session_variables: session, input } = req.body;

  const requestInput = input ?? req.body;

  const modulePath = `./src/rpc/${hyphensToCamelCase(method)}.js`;
  const module = await import(modulePath);

  if (!module) {
    return res.status(404).json({
      code: "method_not_found",
      message: `Module "${modulePath}" not found. Check the server logs`,
    });
  }

  const data = await module.default(session, requestInput, req.headers);

  if (data) {
    if (data.error) {
      return res.status(400).json(data);
    }

    return res.json(data);
  }

  return res.status(400).json({
    code: "method_has_no_output",
    message: `No output from the method "${method}". Check the script`,
  });
});

app.listen(port);

if (dev) {
  logger.log("Development mode: ON");
  logger.log(`Express server is running, go to http://localhost:${port}`);
}
