package site.daydream.mote.service

import com.drew.imaging.ImageMetadataReader
import com.drew.metadata.exif.ExifIFD0Directory
import net.coobird.thumbnailator.Thumbnails
import org.springframework.context.annotation.Lazy
import org.springframework.stereotype.Service
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.NotFoundException
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap

@Service
class DriveThumbService(
    @Lazy private val driveService: DriveService,
    private val uploadConfig: UploadConfig,
) : DriveThumbServiceProvider {

    private val locks = ConcurrentHashMap<String, Any>()

    fun thumbnail(id: Long): File {
        val n = driveService.findById(id)
        if (n.type != "file" || n.blobPath.isNullOrBlank() || n.deletedAt != null) {
            throw NotFoundException("drive node not found")
        }
        val ext = n.ext?.lowercase() ?: ""
        if (ext !in IMAGE_EXTS) throw BadRequestException("not an image")

        val srcAbs = Paths.get(uploadConfig.uploadDir, n.blobPath)
        val thumbsDir = Paths.get(uploadConfig.uploadDir, "drive", "_thumbs")
        Files.createDirectories(thumbsDir)

        val thumbAbs = thumbsDir.resolve(File(n.blobPath).name + ".jpg").toFile()
        if (thumbAbs.exists() && thumbAbs.length() > 0) return thumbAbs

        val key = thumbAbs.absolutePath
        val lock = locks.computeIfAbsent(key) { Any() }
        synchronized(lock) {
            if (thumbAbs.exists() && thumbAbs.length() > 0) return thumbAbs
            try {
                generate(srcAbs.toFile(), thumbAbs)
            } finally {
                locks.remove(key)
            }
        }
        return thumbAbs
    }

    private fun generate(src: File, dst: File) {
        val orientation = runCatching {
            val md = ImageMetadataReader.readMetadata(src)
            val dir = md.getFirstDirectoryOfType(ExifIFD0Directory::class.java)
            if (dir?.containsTag(ExifIFD0Directory.TAG_ORIENTATION) == true) {
                dir.getInt(ExifIFD0Directory.TAG_ORIENTATION)
            } else null
        }.getOrNull()

        val rotateDeg = when (orientation) {
            6 -> 90.0
            3 -> 180.0
            8 -> 270.0
            else -> 0.0
        }

        val tmp = File(dst.absolutePath + ".part")
        try {
            var builder = Thumbnails.of(src)
                .size(THUMB_WIDTH, THUMB_WIDTH)
                .keepAspectRatio(true)
                .outputQuality(0.82)
                .outputFormat("jpg")
            if (rotateDeg != 0.0) builder = builder.rotate(rotateDeg)
            builder.toFile(tmp)

            // Thumbnailator may append `.jpg` to the output path if no extension is present.
            val produced = if (tmp.exists()) tmp else File(tmp.absolutePath + ".jpg")
            Files.move(produced.toPath(), dst.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Exception) {
            tmp.delete()
            File(tmp.absolutePath + ".jpg").delete()
            throw e
        }
    }

    override fun purgeThumb(blobPath: String) {
        if (blobPath.isBlank()) return
        val name = File(blobPath).name + ".jpg"
        val thumbAbs = Paths.get(uploadConfig.uploadDir, "drive", "_thumbs", name).toFile()
        runCatching { thumbAbs.delete() }
    }

    companion object {
        private const val THUMB_WIDTH = 240
        private val IMAGE_EXTS = setOf(".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff")
    }
}
