-- Cloud-drive feature: hierarchical files/folders, chunked uploads, public shares.

CREATE TABLE IF NOT EXISTS drive_nodes
(
  id              INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  parent_id       INTEGER,
  type            TEXT    NOT NULL CHECK (type IN ('folder', 'file')),
  name            TEXT    NOT NULL,
  blob_path       TEXT,
  size            BIGINT,
  hash            TEXT,
  deleted_at      BIGINT,
  delete_batch_id TEXT,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES drive_nodes (id) ON DELETE CASCADE,
  CHECK ((type = 'folder' AND blob_path IS NULL AND size IS NULL)
      OR (type = 'file'   AND blob_path IS NOT NULL AND size IS NOT NULL))
);

-- Active-name uniqueness within a parent (NULL parent treated as 0 via expression).
CREATE UNIQUE INDEX IF NOT EXISTS drive_nodes_unique_active
  ON drive_nodes (COALESCE(parent_id, 0), LOWER(name))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS drive_nodes_parent ON drive_nodes (parent_id, deleted_at);
CREATE INDEX IF NOT EXISTS drive_nodes_deleted ON drive_nodes (deleted_at);
CREATE INDEX IF NOT EXISTS drive_nodes_name ON drive_nodes (LOWER(name));
CREATE INDEX IF NOT EXISTS drive_nodes_delete_batch ON drive_nodes (delete_batch_id);

CREATE TABLE IF NOT EXISTS drive_uploads
(
  id            TEXT PRIMARY KEY NOT NULL,
  parent_id     INTEGER,
  name          TEXT    NOT NULL,
  size          BIGINT  NOT NULL,
  chunk_size    BIGINT  NOT NULL,
  total_chunks  INTEGER NOT NULL,
  received_mask BLOB    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('uploading', 'assembling', 'done', 'failed')),
  expires_at    BIGINT  NOT NULL,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES drive_nodes (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS drive_uploads_expires ON drive_uploads (expires_at);

CREATE TABLE IF NOT EXISTS drive_shares
(
  id            INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  node_id       INTEGER NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,
  token_prefix  TEXT    NOT NULL,
  password_hash TEXT,
  expires_at    BIGINT,
  created_at    BIGINT  NOT NULL,
  FOREIGN KEY (node_id) REFERENCES drive_nodes (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_shares_prefix ON drive_shares (token_prefix);
CREATE INDEX IF NOT EXISTS drive_shares_node ON drive_shares (node_id);
