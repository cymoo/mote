use crate::service::drive_service::{DriveError, DriveResult, DriveService};
use async_zip::base::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
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
