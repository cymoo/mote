-- Starred flag: NULL = not starred; epoch-ms when starred (doubles as sort key).
ALTER TABLE drive_nodes ADD COLUMN starred_at BIGINT;

-- Dedup lookups (FindReusableBlob) filter by content hash.
CREATE INDEX IF NOT EXISTS drive_nodes_hash
  ON drive_nodes (hash) WHERE hash IS NOT NULL;

-- Blob refcount checks (removeBlobIfOrphan) and physical-usage stats
-- filter/group by blob_path.
CREATE INDEX IF NOT EXISTS drive_nodes_blob_path
  ON drive_nodes (blob_path) WHERE blob_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS drive_nodes_starred
  ON drive_nodes (starred_at) WHERE starred_at IS NOT NULL;
