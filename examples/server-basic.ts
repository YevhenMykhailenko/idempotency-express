import express from "express";

import { idempotencyMiddleware, MemoryStore } from "../src/index.js";

const app = express();
app.use(express.json());

const store = new MemoryStore();

app.post(
  "/payments",
  idempotencyMiddleware({
    store,
    ttlMs: 24 * 60 * 60 * 1000,
    keyHeader: "Idempotency-Key",
    inFlight: { strategy: "wait", waitTimeoutMs: 3000, pollMs: 100 },
    replay: { headerWhitelist: ["location"] },
    fingerprint: {
      includeQuery: false,
      custom: (req) => (req.headers["x-tenant-id"] as string | undefined),
      maxBodyBytes: 64 * 1024
    }
  }),
  async (req, res) => {
    // Simulate work
    await new Promise((r) => setTimeout(r, 300));
    const orderId = Math.random().toString(36).slice(2);
    res.setHeader("Location", `/orders/${orderId}`);
    res.status(201).json({ orderId });
  }
);

app.listen(3000, () => console.log("Server on http://localhost:3000"));
