CREATE TABLE links (
  code VARCHAR(32) PRIMARY KEY,
  target_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  clicks BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT links_code_format
    CHECK (code ~ '^[A-Za-z0-9_-]{4,32}$'),

  CONSTRAINT links_target_url_length
    CHECK (char_length(target_url) BETWEEN 1 AND 2048),

  CONSTRAINT links_clicks_nonnegative
    CHECK (clicks >= 0)
);

CREATE INDEX links_expires_at_idx
  ON links (expires_at)
  WHERE expires_at IS NOT NULL;