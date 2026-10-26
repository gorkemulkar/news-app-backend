-- News articles fetched and scored by the app.
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,                       -- topic id from topics.json
  headline TEXT NOT NULL,
  source TEXT,
  published_at TEXT,                         -- ISO 8601
  url TEXT NOT NULL UNIQUE,
  summary TEXT,                              -- AI-generated
  relevance_score INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_articles_topic_published ON articles (topic, published_at DESC);
