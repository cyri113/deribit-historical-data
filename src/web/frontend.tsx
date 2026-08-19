import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

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

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "N/A";
  return new Date(timestamp).toISOString().split("T")[0];
}

function formatPercent(progress: number, total: number): string {
  if (total === 0) return "0%";
  return ((progress / total) * 100).toFixed(1) + "%";
}

function StatusBadge({ status }: { status: string }) {
  const symbols = {
    completed: "✓",
    in_progress: "⏳",
    pending: "⋯",
    failed: "✗",
  };

  const symbol = symbols[status as keyof typeof symbols] || "?";

  return <span className={`status status-${status}`}>{symbol}</span>;
}

function ProgressBar({ progress, total }: { progress: number; total: number }) {
  const percent = total === 0 ? 0 : (progress / total) * 100;
  const width = Math.min(percent, 100);

  return (
    <div className="progress-bar-container">
      <div className="progress-bar-fill" style={{ width: `${width}%` }} />
      <span className="progress-bar-text">
        {formatNumber(progress)} / {formatNumber(total)}
      </span>
    </div>
  );
}

function Dashboard() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [currency, setCurrency] = useState("BTC");
  const [filter, setFilter] = useState<"all" | "option" | "future">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "in_progress" | "pending" | "completed">("in_progress");
  const [sortBy, setSortBy] = useState<"name" | "progress" | "trades">("progress");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    // WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;
    const websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log("WebSocket connected");
      websocket.send(JSON.stringify({ type: "subscribe", currency }));
    };

    websocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "progress") {
        setData(msg.data);
        setLastUpdate(new Date());
      }
    };

    websocket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    websocket.onclose = () => {
      console.log("WebSocket disconnected");
    };

    setWs(websocket);

    return () => {
      websocket.close();
    };
  }, []);

  // Send currency change to WebSocket when user switches currencies
  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", currency }));
    }
  }, [currency, ws]);

  if (!data) {
    return (
      <div className="container">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  // Filter instruments
  let filteredInstruments = data.instruments.filter((inst) => {
    if (filter !== "all" && inst.kind !== filter) return false;
    if (statusFilter !== "all" && inst.status !== statusFilter) return false;
    return true;
  });

  // Sort instruments
  filteredInstruments.sort((a, b) => {
    let compareValue = 0;

    if (sortBy === "name") {
      compareValue = a.name.localeCompare(b.name);
    } else if (sortBy === "progress") {
      const aPercent = a.total === 0 ? 0 : (a.progress / a.total);
      const bPercent = b.total === 0 ? 0 : (b.progress / b.total);
      compareValue = aPercent - bPercent;
    } else if (sortBy === "trades") {
      compareValue = a.tradeCount - b.tradeCount;
    }

    return sortOrder === "asc" ? compareValue : -compareValue;
  });

  // Pagination
  const totalPages = Math.ceil(filteredInstruments.length / pageSize);
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedInstruments = filteredInstruments.slice(startIndex, endIndex);

  // Overall progress
  const overallProgress = data.highLevel.totalInstruments === 0
    ? 0
    : (data.highLevel.completedInstruments / data.highLevel.totalInstruments) * 100;

  return (
    <div className="container">
      <header className="header">
        <h1 className="title">$ deribit-progress --currency {currency}</h1>
        <div className="controls">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
            <option value="SOL">SOL</option>
          </select>
        </div>
      </header>

      <section className="overall-progress">
        <div className="overall-progress-label">
          Overall Progress: {data.highLevel.completedInstruments} / {data.highLevel.totalInstruments} instruments ({overallProgress.toFixed(1)}%)
        </div>
        <div className="overall-progress-bar">
          <div className="overall-progress-fill" style={{ width: `${overallProgress}%` }} />
        </div>
      </section>

      <section className="summary">
        <div className="summary-row">
          <div className="summary-card">
            <div className="summary-label">Instruments</div>
            <div className="summary-value">
              {data.highLevel.completedInstruments} / {data.highLevel.totalInstruments}
            </div>
            <div className="summary-percent">
              {formatPercent(
                data.highLevel.completedInstruments,
                data.highLevel.totalInstruments
              )}
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-label">Options</div>
            <div className="summary-value">
              {data.highLevel.completedOptions} / {data.highLevel.totalOptions}
            </div>
            <div className="summary-percent">
              {formatPercent(data.highLevel.completedOptions, data.highLevel.totalOptions)}
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-label">Futures</div>
            <div className="summary-value">
              {data.highLevel.completedFutures} / {data.highLevel.totalFutures}
            </div>
            <div className="summary-percent">
              {formatPercent(data.highLevel.completedFutures, data.highLevel.totalFutures)}
            </div>
          </div>

          <div className="summary-card">
            <div className="summary-label">Total Trades</div>
            <div className="summary-value">{formatNumber(data.highLevel.totalTrades)}</div>
          </div>
        </div>
      </section>

      <section className="filters">
        <div className="filter-group">
          <label>Type:</label>
          <select value={filter} onChange={(e) => { setFilter(e.target.value as any); setPage(1); }}>
            <option value="all">All</option>
            <option value="option">Options</option>
            <option value="future">Futures</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Status:</label>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as any); setPage(1); }}>
            <option value="all">All</option>
            <option value="in_progress">In Progress (Active)</option>
            <option value="pending">Pending (Not Started)</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Sort by:</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
            <option value="progress">Progress</option>
            <option value="name">Name</option>
            <option value="trades">Trades</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Order:</label>
          <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as any)}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Per page:</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </div>

        <div className="filter-count">
          Showing {startIndex + 1}-{Math.min(endIndex, filteredInstruments.length)} of {filteredInstruments.length}
        </div>
      </section>

      <section className="table-section">
        <table className="instruments-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Instrument</th>
              <th>Type</th>
              <th>Expiration</th>
              <th>Progress</th>
              <th>Trades</th>
            </tr>
          </thead>
          <tbody>
            {paginatedInstruments.map((inst) => (
              <tr key={inst.name} className={`row-${inst.status}`}>
                <td>
                  <StatusBadge status={inst.status} />
                </td>
                <td className="instrument-name">{inst.name}</td>
                <td className="instrument-type">{inst.kind}</td>
                <td className="expiration">{formatDate(inst.expiration)}</td>
                <td className="progress-cell">
                  <ProgressBar progress={inst.progress} total={inst.total} />
                </td>
                <td className="trade-count">{formatNumber(inst.tradeCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="pagination">
        <button
          className="pagination-btn"
          disabled={page === 1}
          onClick={() => setPage(1)}
        >
          ««
        </button>
        <button
          className="pagination-btn"
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          «
        </button>
        <span className="pagination-info">
          Page {page} of {totalPages}
        </span>
        <button
          className="pagination-btn"
          disabled={page === totalPages}
          onClick={() => setPage(page + 1)}
        >
          »
        </button>
        <button
          className="pagination-btn"
          disabled={page === totalPages}
          onClick={() => setPage(totalPages)}
        >
          »»
        </button>
      </section>

      <footer className="footer">
        <span className="footer-text">
          Last updated: {lastUpdate.toLocaleTimeString()} | Auto-refresh: 100ms
        </span>
      </footer>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Dashboard />);
