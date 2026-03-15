package site.daydream.mote.service

import com.drew.imaging.ImageMetadataReader
import com.drew.metadata.exif.ExifIFD0Directory
import net.coobird.thumbnailator.Thumbnails
import org.slf4j.LoggerFactory
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.model.FileInfo
import java.awt.image.BufferedImage
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.*
import javax.imageio.ImageIO

class UploadService(private val uploadConfig: UploadConfig) {
    private val logger = LoggerFactory.getLogger(UploadService::class.java)

    init {
        val path = Paths.get(uploadConfig.uploadDir)
        if (!Files.exists(path)) {
            Files.createDirectories(path)
        }
    }

    fun handleFileUpload(filename: String, contentType: String?, inputStream: InputStream): FileInfo {
        if (filename.isBlank()) {
            throw BadRequestException("Filename is required")
        }

        val secureFilename = generateSecureFilename(filename)
        val filepath = Paths.get(uploadConfig.uploadDir, secureFilename)

        Files.copy(inputStream, filepath, StandardCopyOption.REPLACE_EXISTING)

        return when {
            isImage(contentType) -> processImageFile(filepath, contentType!!)
            else -> processRegularFile(filepath)
        }
    }

    private fun processRegularFile(filepath: Path): FileInfo {
        return FileInfo(
            url = "/${uploadConfig.uploadUrl}/${filepath.fileName}",
            size = filepath.toFile().length(),
            thumbUrl = null,
            width = null,
            height = null
        )
    }

    private fun isImage(contentType: String?): Boolean {
        return contentType?.removePrefix("image/") in uploadConfig.imageFormats
    }

    private fun processImageFile(filepath: Path, contentType: String): FileInfo {
        val file = filepath.toFile()
        val bufferedImage = ImageIO.read(file)

        val metadata = ImageMetadataReader.readMetadata(file)
        val exifDirectory = metadata.getFirstDirectoryOfType(ExifIFD0Directory::class.java)
        val orientation = if (exifDirectory?.containsTag(ExifIFD0Directory.TAG_ORIENTATION) == true) {
            exifDirectory.getInt(ExifIFD0Directory.TAG_ORIENTATION)
        } else {
            null
        }

        val finalImage = when (orientation) {
            6 -> rotateImage(bufferedImage, 90)
            3 -> rotateImage(bufferedImage, 180)
            8 -> rotateImage(bufferedImage, 270)
            else -> bufferedImage
        }

        if (orientation != null && orientation != 1) {
            ImageIO.write(finalImage, contentType.removePrefix("image/"), file)
        }

        val thumbUrl = runCatching { generateThumbnail(filepath, finalImage) }.getOrNull()

        return FileInfo(
            url = "/${uploadConfig.uploadUrl}/${filepath.fileName}",
            thumbUrl = thumbUrl?.let { "/${uploadConfig.uploadUrl}/${it.name}" },
            size = file.length(),
            width = finalImage.width,
            height = finalImage.height
        )
    }

    private fun rotateImage(bufferedImage: BufferedImage, degrees: Int): BufferedImage {
        return Thumbnails.of(bufferedImage)
            .scale(1.0)
            .rotate(degrees.toDouble())
            .asBufferedImage()
    }

    private fun generateThumbnail(originalPath: Path, image: BufferedImage): File {
        return Paths.get(uploadConfig.uploadDir, "thumb_${originalPath.fileName}").toFile().also {
            Thumbnails.of(image)
                .size(uploadConfig.thumbnailSize, uploadConfig.thumbnailSize)
                .keepAspectRatio(true)
                .toFile(it)
        }
    }
}

val INVALID_CHARS_REGEX = Regex("[^\\w\\-.\\u4e00-\\u9fa5]+")

fun generateSecureFilename(filename: String, uuidLength: Int = 8): String {
    require(filename.isNotBlank()) { "Filename cannot be blank" }
    require(uuidLength in 8..32) { "UUID length must be between 8 and 32" }

    val sanitizedName = filename.trim().replace(INVALID_CHARS_REGEX, "_")
    val (baseName, extension) = splitFileName(sanitizedName)
    val uuid = UUID.randomUUID().toString().replace("-", "").take(uuidLength)

    return buildString {
        append(baseName)
        append('.')
        append(uuid)
        if (extension.isNotEmpty()) {
            append('.')
            append(extension)
        }
    }
}

fun splitFileName(fileName: String): Pair<String, String> {
    if (fileName.startsWith(".")) {
        val remaining = fileName.substring(1)
        val lastDotIndex = remaining.lastIndexOf('.')
        return if (lastDotIndex < 0) {
            ".$remaining" to ""
        } else {
            ".${remaining.take(lastDotIndex)}" to remaining.substring(lastDotIndex + 1)
        }
    }

    val lastDotIndex = fileName.lastIndexOf('.')
    return when {
        lastDotIndex <= 0 -> fileName to ""
        else -> fileName.take(lastDotIndex) to fileName.substring(lastDotIndex + 1)
    }
}
