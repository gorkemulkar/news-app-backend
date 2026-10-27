-- Why Claude gave an article its relevance score (one sentence, shown on the dashboard).
ALTER TABLE articles ADD COLUMN score_reason TEXT;

-- Per-topic results of each run as JSON (candidates, known_excluded, returned, inserted, errors).
ALTER TABLE pipeline_runs ADD COLUMN details TEXT;
