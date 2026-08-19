import { test, expect } from "bun:test";

test("Web server API returns progress data", async () => {
  // Start server
  const proc = Bun.spawn(["bun", "src/web/server.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Test API endpoint
    const response = await fetch("http://localhost:3000/api/progress/BTC");
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("highLevel");
    expect(data).toHaveProperty("instruments");
    expect(Array.isArray(data.instruments)).toBe(true);

    // Verify high-level structure
    expect(data.highLevel).toHaveProperty("totalInstruments");
    expect(data.highLevel).toHaveProperty("completedInstruments");
    expect(data.highLevel).toHaveProperty("totalTrades");

    // Verify instrument structure if any exist
    if (data.instruments.length > 0) {
      const inst = data.instruments[0];
      expect(inst).toHaveProperty("name");
      expect(inst).toHaveProperty("kind");
      expect(inst).toHaveProperty("status");
      expect(inst).toHaveProperty("progress");
      expect(inst).toHaveProperty("total");
      expect(inst).toHaveProperty("tradeCount");

      // Verify status is valid
      expect(["pending", "in_progress", "completed"]).toContain(inst.status);
    }
  } finally {
    // Kill server
    proc.kill();
  }
});

test("Web server serves HTML", async () => {
  // Start server
  const proc = Bun.spawn(["bun", "src/web/server.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Test HTML endpoint
    const response = await fetch("http://localhost:3000/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Deribit Progress Dashboard");
  } finally {
    // Kill server
    proc.kill();
  }
});
