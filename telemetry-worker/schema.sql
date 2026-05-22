CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_timestamp TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_timestamp ON entries(agent_id, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_type_timestamp ON entries(type, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_created_at ON entries(created_at);
