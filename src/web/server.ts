#!/usr/bin/env bun

import { Database } from "../infrastructure/database.ts";

const PORT = 3000;

interface ProgressData {
  highLevel: {
    totalInstruments: number;
    completedInstruments: number;
    totalOptions: number;
    completedOptions: number;
    totalFutures: number;
    completedFutures: number;
    totalTrades: number;
  };
  instruments: Array<{
    name: string;
    kind: string;
    expiration?: number;
    progress: number;
    total: number;
    status: string;
    tradeCount: number;
  }>;
}

// Track currency subscription for each WebSocket client
const clientCurrencies = new Map<any, string>();

function getProgressData(currency: string = "BTC"): ProgressData {
  const db = new Database();

  try {
    // Get all instruments
    const allInstruments = db.getInstruments(currency);

    const options = allInstruments.filter(i => i.kind === "option");
    const futures = allInstruments.filter(i => i.kind === "future");

    // Get option progress
    const optionProgress = options.map(opt => {
      const progress = db.getOptionProgress(opt.instrument_name);

      // Determine actual status:
      // - pending: not started yet (last_no = 0)
      // - in_progress: actively downloading (last_no > 0 and status != completed)
      // - completed: finished
      let actualStatus = progress.status;
      if (progress.status === "in_progress" && progress.last_no === 0) {
        actualStatus = "pending";
      }

      return {
        name: opt.instrument_name,
        kind: "option",
        expiration: opt.expiration_timestamp,
        progress: progress.last_no,
        total: progress.trade_count, // Use trade_count as total (this is the actual lastSeq)
        status: actualStatus,
        tradeCount: progress.trade_count,
      };
    });

    // Get future progress
    const futureProgress = futures.map(fut => {
      const stats = db.getFutureChunkStats(fut.instrument_name);

      // Determine actual status for futures:
      // - pending: no chunks created yet (total = 0)
      // - in_progress: has chunks and some are pending
      // - completed: all chunks done
      let actualStatus = "pending";
      if (stats.total === 0) {
        actualStatus = "pending";
      } else if (stats.pending === 0) {
        actualStatus = "completed";
      } else {
        actualStatus = "in_progress";
      }

      return {
        name: fut.instrument_name,
        kind: "future",
        expiration: fut.expiration_timestamp,
        progress: stats.done,
        total: stats.total,
        status: actualStatus,
        tradeCount: 0, // Could calculate from chunks
      };
    });

    const allProgress = [...optionProgress, ...futureProgress];
    const completedOptions = optionProgress.filter(o => o.status === "completed").length;
    const completedFutures = futureProgress.filter(f => f.status === "completed").length;
    const totalTrades = optionProgress.reduce((sum, o) => sum + o.tradeCount, 0);

    return {
      highLevel: {
        totalInstruments: allInstruments.length,
        completedInstruments: completedOptions + completedFutures,
        totalOptions: options.length,
        completedOptions,
        totalFutures: futures.length,
        completedFutures,
        totalTrades,
      },
      instruments: allProgress.sort((a, b) => {
        // Sort by status (in_progress first), then by name
        if (a.status === "in_progress" && b.status !== "in_progress") return -1;
        if (a.status !== "in_progress" && b.status === "in_progress") return 1;
        return a.name.localeCompare(b.name);
      }),
    };
  } finally {
    db.close();
  }
}

const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (server.upgrade(req)) {
      return; // WebSocket upgrade handled
    }

    // Handle /api/progress/:currency
    if (url.pathname.startsWith("/api/progress/")) {
      const currency = url.pathname.split("/").pop()?.toUpperCase() || "BTC";
      const data = getProgressData(currency);
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Serve CSS
    if (url.pathname === "/styles.css") {
      return new Response(Bun.file("src/web/styles.css"), {
        headers: { "Content-Type": "text/css" },
      });
    }

    // Serve bundled frontend
    if (url.pathname === "/frontend.js") {
      const result = await Bun.build({
        entrypoints: ["src/web/frontend.tsx"],
        format: "esm",
        minify: false,
        sourcemap: "inline",
      });

      if (!result.success) {
        console.error("Build errors:", result.logs);
        return new Response("Build failed", { status: 500 });
      }

      const output = result.outputs[0];
      return new Response(output, {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    // Serve HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Deribit Progress Dashboard</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/frontend.js"></script>
  </body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log("WebSocket client connected");
      // Default to BTC
      clientCurrencies.set(ws, "BTC");

      // Send initial data
      const data = getProgressData("BTC");
      ws.send(JSON.stringify({ type: "progress", data }));
    },

    message(ws, message) {
      const msg = JSON.parse(message as string);

      if (msg.type === "subscribe") {
        const currency = (msg.currency || "BTC").toUpperCase();
        clientCurrencies.set(ws, currency);

        // Send immediate update for new currency
        const data = getProgressData(currency);
        ws.send(JSON.stringify({ type: "progress", data }));
      }
    },

    close(ws) {
      console.log("WebSocket client disconnected");
      clientCurrencies.delete(ws);
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`\n🚀 Deribit Progress Dashboard running at http://localhost:${PORT}\n`);

// Periodic progress broadcast (every 100ms)
// Send currency-specific updates to each connected client
setInterval(() => {
  // Group clients by currency to minimize database queries
  const currencyGroups = new Map<string, any[]>();

  for (const [ws, currency] of clientCurrencies.entries()) {
    if (!currencyGroups.has(currency)) {
      currencyGroups.set(currency, []);
    }
    currencyGroups.get(currency)!.push(ws);
  }

  // Fetch and send data for each currency
  for (const [currency, clients] of currencyGroups.entries()) {
    const data = getProgressData(currency);
    const message = JSON.stringify({ type: "progress", data });

    for (const ws of clients) {
      try {
        ws.send(message);
      } catch (err) {
        console.error("Failed to send update to client:", err);
      }
    }
  }
}, 100);
