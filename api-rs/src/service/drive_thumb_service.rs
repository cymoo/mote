use crate::service::drive_service::{DriveError, DriveResult, DriveService};
use image::imageops::FilterType;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

const THUMB_WIDTH: u32 = 240;
const IMAGE_EXTS: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"];

pub struct DriveThumbService {
    drive: Arc<DriveService>,
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl DriveThumbService {
    pub fn new(drive: Arc<DriveService>) -> Arc<Self> {
        Arc::new(Self {
            drive,
            locks: Mutex::new(HashMap::new()),
        })
    }

    async fn key_lock(&self, key: &Path) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().await;
        if let Some(m) = map.get(key) {
            return m.clone();
        }
        let m = Arc::new(Mutex::new(()));
        map.insert(key.to_path_buf(), m.clone());
        m
    }

    pub async fn thumbnail(&self, id: i64) -> DriveResult<PathBuf> {
        let n = self.drive.find_by_id(id).await?;
        if n.r#type != "file" || n.deleted_at.is_some() {
            return Err(DriveError::NotFound);
        }
        let blob = n.blob_path.clone().ok_or(DriveError::NotFound)?;
        let ext = Path::new(&n.name)
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            return Err(DriveError::NotImage);
        }
        let src_abs = self.drive.blob_abs_path(&blob);
        let thumbs_dir = Path::new(&self.drive.config.base_path)
            .join("drive")
            .join("_thumbs");
        tokio::fs::create_dir_all(&thumbs_dir).await?;
        let basename = Path::new(&blob)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let thumb_abs = thumbs_dir.join(format!("{}.jpg", basename));

        if let Ok(st) = tokio::fs::metadata(&thumb_abs).await {
            if st.len() > 0 {
                return Ok(thumb_abs);
            }
        }
        let lock = self.key_lock(&thumb_abs).await;
        let _g = lock.lock().await;
        if let Ok(st) = tokio::fs::metadata(&thumb_abs).await {
            if st.len() > 0 {
                return Ok(thumb_abs);
            }
        }
        let thumb_clone = thumb_abs.clone();
        tokio::task::spawn_blocking(move || -> DriveResult<()> {
            let img = image::open(&src_abs)
                .map_err(|e| DriveError::Other(anyhow::anyhow!("decode: {}", e)))?;
            let w = img.width();
            let h = img.height();
            if w == 0 || h == 0 {
                return Err(DriveError::Other(anyhow::anyhow!("zero dim")));
            }
            let tw = std::cmp::min(THUMB_WIDTH, w);
            let th = (h * tw / w).max(1);
            let thumb = img.resize_exact(tw, th, FilterType::Lanczos3);
            let tmp = thumb_clone.with_extension("jpg.part");
            {
                let mut f = std::fs::File::create(&tmp)?;
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 82);
                enc.encode_image(&thumb)
                    .map_err(|e| DriveError::Other(anyhow::anyhow!("encode: {}", e)))?;
            }
            std::fs::rename(&tmp, &thumb_clone)?;
            Ok(())
        })
        .await
        .map_err(|e| DriveError::Other(anyhow::anyhow!(e)))??;
        Ok(thumb_abs)
    }
}
