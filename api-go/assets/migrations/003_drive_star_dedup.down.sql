DROP INDEX IF EXISTS drive_nodes_starred;
DROP INDEX IF EXISTS drive_nodes_blob_path;
DROP INDEX IF EXISTS drive_nodes_hash;
ALTER TABLE drive_nodes DROP COLUMN starred_at;
