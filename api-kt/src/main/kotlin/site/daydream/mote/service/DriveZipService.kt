package site.daydream.mote.service

import org.springframework.stereotype.Service
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.NotFoundException
import java.io.File
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@Service
class DriveZipService(
    private val driveService: DriveService,
) {
    fun zipFolder(folderId: Long, out: OutputStream) {
        val root = driveService.findById(folderId)
        if (root.type != "folder" || root.deletedAt != null) {
            throw BadRequestException("drive node not found")
        }
        val descendants = driveService.collectDescendants(folderId)

        ZipOutputStream(out).use { zw ->
            val seen = HashSet<String>()
            for (d in descendants) {
                if (d.id == folderId) continue
                var rel = d.relPath.removePrefix(root.name).removePrefix("/")
                rel = sanitizeZipPath(rel)
                if (rel.isBlank()) continue
                val name = if (d.type == "folder") "$rel/" else rel
                if (!seen.add(name)) continue
                zw.putNextEntry(ZipEntry(name))
                if (d.type == "file" && !d.blobPath.isNullOrBlank()) {
                    val f = File(driveService.blobAbsPath(d.blobPath))
                    if (f.exists()) f.inputStream().use { it.copyTo(zw) }
                }
                zw.closeEntry()
            }
        }
    }

    companion object {
        private fun sanitizeZipPath(p: String): String =
            p.split('/')
                .map { it.trim() }
                .filter { it.isNotEmpty() && it != "." && it != ".." }
                .joinToString("/")
    }
}
