-- One row per /agent or scheduled pipeline run; drives "last refreshed" and the manual-run cooldown.
CREATE TABLE pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,                     -- manual | scheduled
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at TEXT,
  articles_inserted INTEGER,
  articles_skipped INTEGER,
  total_returned INTEGER,
  error TEXT
);
