use crate::model::drive::DriveNode;
use crate::service::drive_service::{DriveError, DriveResult, DriveService};
use async_zip::base::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_util::compat::FuturesAsyncWriteCompatExt;

pub struct DriveZipService {
    drive: Arc<DriveService>,
}

impl DriveZipService {
    pub fn new(drive: Arc<DriveService>) -> Arc<Self> {
        Arc::new(Self { drive })
    }

    /// Streams a zip archive of the folder to the given async writer (e.g. a
    /// duplex pipe whose other end is used as the response body).
    pub async fn zip_folder<W: tokio::io::AsyncWrite + Unpin>(
        &self,
        folder_id: i64,
        writer: W,
    ) -> DriveResult<()> {
        let root = self.drive.find_by_id(folder_id).await?;
        if root.r#type != "folder" || root.deleted_at.is_some() {
            return Err(DriveError::NotFound);
        }
        let descendants = self.drive.collect_descendants(folder_id).await?;

        let writer = tokio_util::compat::TokioAsyncWriteCompatExt::compat_write(writer);
        let mut zw = ZipFileWriter::new(writer);
        let mut seen = std::collections::HashSet::new();
        let root_name = root.name.clone();

        for d in descendants {
            if d.id == folder_id {
                continue;
            }
            let mut rel = d.rel_path.clone();
            if rel.starts_with(&root_name) {
                rel = rel[root_name.len()..].to_string();
            }
            rel = rel.trim_start_matches('/').to_string();
            rel = sanitize_zip_path(&rel);
            if rel.is_empty() {
                continue;
            }
            if !seen.insert(rel.clone()) {
                continue;
            }
            if d.r#type == "folder" {
                let entry =
                    ZipEntryBuilder::new(format!("{}/", rel).into(), Compression::Deflate).build();
                zw.write_entry_whole(entry, &[])
                    .await
                    .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
                continue;
            }
            let Some(blob) = d.blob_path else { continue };
            let abs = self.drive.blob_abs_path(&blob);
            let entry = ZipEntryBuilder::new(rel.into(), Compression::Deflate).build();
            let mut ew = zw
                .write_entry_stream(entry)
                .await
                .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?
                .compat_write();
            match tokio::fs::File::open(&abs).await {
                Ok(mut f) => {
                    if let Err(e) = tokio::io::copy(&mut f, &mut ew).await {
                        let _ = ew.shutdown().await;
                        return Err(DriveError::Io(e));
                    }
                }
                Err(_) => {}
            }
            ew.into_inner()
                .close()
                .await
                .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
        }
        zw.close()
            .await
            .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
        Ok(())
    }

    /// Resolves a multi-select download into its effective root nodes: ids are
    /// deduplicated, ids nested under other selected ids are dropped (their
    /// content arrives via the ancestor), and deleted/missing nodes are
    /// skipped. Returns NotFound when no valid node remains, so the handler
    /// can still send a clean 404 before writing any body.
    pub async fn resolve_zip_targets(&self, ids: &[i64]) -> DriveResult<Vec<DriveNode>> {
        let mut seen = HashSet::with_capacity(ids.len());
        let mut uniq = Vec::with_capacity(ids.len());
        for &id in ids {
            if seen.insert(id) {
                uniq.push(id);
            }
        }
        let nested = self.nested_selections(&uniq).await?;

        let mut targets = Vec::with_capacity(uniq.len());
        for &id in &uniq {
            if nested.contains(&id) {
                continue;
            }
            match self.drive.find_by_id(id).await {
                Ok(n) if n.deleted_at.is_none() => targets.push(n),
                Ok(_) | Err(DriveError::NotFound) => continue,
                Err(e) => return Err(e),
            }
        }
        if targets.is_empty() {
            return Err(DriveError::NotFound);
        }
        Ok(targets)
    }

    /// Streams a zip archive of the given nodes. Unlike zip_folder — which
    /// strips the root folder's own name — selected folders appear as
    /// top-level directories and selected files as top-level entries.
    /// Same-named top-level entries get a "name (1)" suffix rather than being
    /// silently dropped: a multi-select from search results can legitimately
    /// pick same-named nodes from different folders.
    pub async fn zip_nodes<W: tokio::io::AsyncWrite + Unpin>(
        &self,
        targets: &[DriveNode],
        writer: W,
    ) -> DriveResult<()> {
        let writer = tokio_util::compat::TokioAsyncWriteCompatExt::compat_write(writer);
        let mut zw = ZipFileWriter::new(writer);

        let mut top_level: HashSet<String> = HashSet::new();
        for root in targets {
            if root.r#type == "file" {
                let name = unique_top_level(&mut top_level, &sanitize_zip_path(&root.name));
                if name.is_empty() || root.blob_path.is_none() {
                    continue;
                }
                let abs = root
                    .blob_path
                    .as_deref()
                    .map(|b| self.drive.blob_abs_path(b));
                write_file_entry(&mut zw, &name, abs).await?;
                continue;
            }

            let descendants = self.drive.collect_descendants(root.id).await?;
            let top_name = unique_top_level(&mut top_level, &sanitize_zip_path(&root.name));
            if top_name.is_empty() {
                continue;
            }
            let mut seen: HashSet<String> = HashSet::new();
            for d in descendants {
                let rel = if d.id == root.id {
                    top_name.clone()
                } else {
                    // rel_path starts with the root's own name; swap it for the
                    // (possibly suffixed) reserved top-level name.
                    let mut sub = d.rel_path.clone();
                    if sub.starts_with(&root.name) {
                        sub = sub[root.name.len()..].to_string();
                    }
                    let sub = sanitize_zip_path(sub.trim_start_matches('/'));
                    if sub.is_empty() {
                        continue;
                    }
                    format!("{}/{}", top_name, sub)
                };
                if !seen.insert(rel.clone()) {
                    continue;
                }
                if d.r#type == "folder" {
                    let entry =
                        ZipEntryBuilder::new(format!("{}/", rel).into(), Compression::Deflate)
                            .build();
                    zw.write_entry_whole(entry, &[])
                        .await
                        .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
                    continue;
                }
                let abs = d.blob_path.as_deref().map(|b| self.drive.blob_abs_path(b));
                write_file_entry(&mut zw, &rel, abs).await?;
            }
        }
        zw.close()
            .await
            .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
        Ok(())
    }

    /// Returns the subset of ids that are strict descendants of other ids in
    /// the same selection (possible when multi-selecting from search results,
    /// where ancestors and descendants can appear side by side).
    async fn nested_selections(&self, ids: &[i64]) -> DriveResult<HashSet<i64>> {
        let mut out = HashSet::new();
        if ids.len() < 2 {
            return Ok(out);
        }
        let ids_json = serde_json::to_string(ids).map_err(anyhow::Error::from)?;
        let rows: Vec<(i64,)> = sqlx::query_as(
            r#"
WITH RECURSIVE selected(id) AS (
  SELECT value FROM json_each(?)
),
descendants(id) AS (
  SELECT n.id FROM drive_nodes n WHERE n.parent_id IN (SELECT id FROM selected)
  UNION ALL
  SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
)
SELECT id FROM selected WHERE id IN (SELECT id FROM descendants)"#,
        )
        .bind(ids_json)
        .fetch_all(&self.drive.pool)
        .await?;
        for (id,) in rows {
            out.insert(id);
        }
        Ok(out)
    }
}

/// Writes one file entry, streaming the blob when present; a missing blob
/// file is skipped silently (matches zip_folder's behavior).
async fn write_file_entry<W: futures::io::AsyncWrite + Unpin>(
    zw: &mut ZipFileWriter<W>,
    rel: &str,
    abs: Option<PathBuf>,
) -> DriveResult<()> {
    let entry = ZipEntryBuilder::new(rel.into(), Compression::Deflate).build();
    let mut ew = zw
        .write_entry_stream(entry)
        .await
        .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?
        .compat_write();
    if let Some(abs) = abs {
        if let Ok(mut f) = tokio::fs::File::open(&abs).await {
            if let Err(e) = tokio::io::copy(&mut f, &mut ew).await {
                let _ = ew.shutdown().await;
                return Err(DriveError::Io(e));
            }
        }
    }
    ew.into_inner()
        .close()
        .await
        .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))?;
    Ok(())
}

/// Reserves a unique top-level entry name, suffixing "stem (1).ext" style on
/// collision.
fn unique_top_level(seen: &mut HashSet<String>, name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let ext = std::path::Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let stem = name.strip_suffix(&ext).unwrap_or(name);
    let mut cand = name.to_string();
    let mut i = 1;
    while !seen.insert(cand.clone()) {
        cand = format!("{} ({}){}", stem, i, ext);
        i += 1;
    }
    cand
}

fn sanitize_zip_path(p: &str) -> String {
    let mut out = Vec::new();
    for seg in p.split('/') {
        let s = seg.trim();
        if s.is_empty() || s == "." || s == ".." {
            continue;
        }
        out.push(s);
    }
    out.join("/")
}
