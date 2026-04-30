package site.daydream.mote.service

import org.springframework.dao.support.DataAccessUtils
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.ConflictException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveNode
import site.daydream.mote.model.DriveUpload
import site.daydream.mote.model.DriveUploadInitRequest
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

@Service
class DriveUploadService(
    private val jdbc: NamedParameterJdbcTemplate,
    private val driveService: DriveService,
    private val uploadConfig: UploadConfig,
    txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    private fun chunksDir(uploadId: String): File =
        Paths.get(uploadConfig.uploadDir, "drive", "_chunks", uploadId).toFile()

    fun init(req: DriveUploadInitRequest): DriveUpload {
        DriveService.validateName(req.name)
        if (req.size <= 0 || req.size > MAX_FILE_SIZE) throw BadRequestException("file too large")
        var chunk = if (req.chunkSize <= 0) DEFAULT_CHUNK else req.chunkSize
        if (chunk < (1L shl 20) || chunk > (64L shl 20)) throw BadRequestException("invalid chunk size")
        if (req.parentId != null) driveService.requireActiveFolder(req.parentId)

        val total = ((req.size + chunk - 1) / chunk).toInt()
        val mask = ByteArray((total + 7) / 8)
        val id = DriveService.randomHex(16)
        val now = System.currentTimeMillis()
        val expiresAt = now + UPLOAD_TTL_MS

        Files.createDirectories(chunksDir(id).toPath())
        try {
            jdbc.update(
                """
                INSERT INTO drive_uploads (id, parent_id, name, size, chunk_size, total_chunks, received_mask, status, expires_at, created_at, updated_at)
                VALUES (:id, :pid, :name, :size, :ch, :tot, :mask, 'uploading', :exp, :now, :now)
                """.trimIndent(),
                mapOf(
                    "id" to id, "pid" to req.parentId, "name" to req.name,
                    "size" to req.size, "ch" to chunk, "tot" to total, "mask" to mask,
                    "exp" to expiresAt, "now" to now,
                ),
            )
        } catch (e: Exception) {
            chunksDir(id).deleteRecursively()
            throw e
        }
        return findOrThrow(id)
    }

    fun get(id: String): Pair<DriveUpload, List<Int>> {
        val u = findOrThrow(id)
        return u to decodeMask(u.receivedMask, u.totalChunks)
    }

    fun putChunk(id: String, idx: Int, body: InputStream) {
        val u = findOrThrow(id)
        if (u.status != "uploading") throw BadRequestException("invalid upload state")
        if (idx < 0 || idx >= u.totalChunks) throw BadRequestException("chunk index out of range")

        val expected = if (idx == u.totalChunks - 1) u.size - idx.toLong() * u.chunkSize else u.chunkSize
        val tmp = File(chunksDir(id), "$idx.part")
        val final = File(chunksDir(id), "$idx.bin")

        // Copy up to expected+1 bytes to detect oversize.
        var written = 0L
        tmp.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            var remaining = expected + 1
            while (remaining > 0) {
                val toRead = minOf(buf.size.toLong(), remaining).toInt()
                val n = body.read(buf, 0, toRead)
                if (n < 0) break
                out.write(buf, 0, n)
                written += n
                remaining -= n
            }
        }
        if (written != expected) {
            tmp.delete()
            throw BadRequestException("chunk size mismatch")
        }
        Files.move(tmp.toPath(), final.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)

        // Update bitmap atomically inside a serial transaction.
        tx.execute {
            val cur = jdbc.queryForObject(
                "SELECT received_mask FROM drive_uploads WHERE id = :id",
                mapOf("id" to id), ByteArray::class.java,
            ) ?: throw NotFoundException("upload not found")
            if (idx / 8 >= cur.size) throw BadRequestException("invalid chunk index")
            cur[idx / 8] = (cur[idx / 8].toInt() or (1 shl (idx % 8))).toByte()
            jdbc.update(
                "UPDATE drive_uploads SET received_mask = :m, updated_at = :now WHERE id = :id",
                mapOf("m" to cur, "now" to System.currentTimeMillis(), "id" to id),
            )
        }
    }

    fun complete(id: String, onCollision: String): DriveNode {
        val u = findOrThrow(id)
        val updated = jdbc.update(
            """
            UPDATE drive_uploads SET status = 'assembling', updated_at = :now
            WHERE id = :id AND status = 'uploading'
            """.trimIndent(),
            mapOf("now" to System.currentTimeMillis(), "id" to id),
        )
        if (updated == 0) throw BadRequestException("invalid upload state")

        try {
            val mask = jdbc.queryForObject(
                "SELECT received_mask FROM drive_uploads WHERE id = :id",
                mapOf("id" to id), ByteArray::class.java,
            ) ?: throw NotFoundException("upload not found")
            if (mask.size * 8 < u.totalChunks) throw BadRequestException("invalid upload state")
            for (i in 0 until u.totalChunks) {
                if (mask[i / 8].toInt() and (1 shl (i % 8)) == 0) {
                    throw BadRequestException("upload incomplete")
                }
            }

            if (u.parentId != null) driveService.requireActiveFolder(u.parentId)

            var finalName = u.name
            val existing = driveService.findActiveSibling(u.parentId, finalName)
            if (existing != null) {
                when (onCollision) {
                    "skip" -> {
                        deleteSession(id)
                        return existing
                    }
                    "rename" -> finalName = driveService.autoRename(u.parentId, finalName)
                    "overwrite" -> {
                        // handled below by replaceFileNode
                    }
                    else -> throw ConflictException("name already exists in this folder")
                }
            }

            val blobName = DriveService.newBlobName(finalName)
            val relPath = "drive/$blobName"
            val absPath = Paths.get(uploadConfig.uploadDir, relPath).toFile()
            val tmpAbs = File(absPath.absolutePath + ".part")

            val (hash, written) = try {
                assemble(u, tmpAbs)
            } catch (e: Exception) {
                tmpAbs.delete()
                throw e
            }
            if (written != u.size) {
                tmpAbs.delete()
                throw BadRequestException("final file size mismatch")
            }
            try {
                Files.move(tmpAbs.toPath(), absPath.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: Exception) {
                tmpAbs.delete()
                throw e
            }

            val node = try {
                if (onCollision == "overwrite") {
                    driveService.replaceFileNode(u.parentId, finalName, relPath, hash, u.size)
                } else {
                    driveService.createFileNode(u.parentId, finalName, relPath, hash, u.size)
                }
            } catch (e: Exception) {
                absPath.delete()
                throw e
            }

            deleteSession(id)
            return node
        } catch (e: Exception) {
            // Allow client to retry.
            jdbc.update(
                "UPDATE drive_uploads SET status = 'uploading' WHERE id = :id",
                mapOf("id" to id),
            )
            throw e
        }
    }

    fun cancel(id: String) {
        val n = jdbc.update(
            "DELETE FROM drive_uploads WHERE id = :id AND status = 'uploading'",
            mapOf("id" to id),
        )
        if (n > 0) chunksDir(id).deleteRecursively()
    }

    fun purgeExpired(): Int {
        val ids = jdbc.queryForList(
            "SELECT id FROM drive_uploads WHERE expires_at < :now",
            mapOf("now" to System.currentTimeMillis()),
            String::class.java,
        )
        ids.forEach { deleteSession(it) }
        return ids.size
    }

    private fun deleteSession(id: String) {
        jdbc.update("DELETE FROM drive_uploads WHERE id = :id", mapOf("id" to id))
        chunksDir(id).deleteRecursively()
    }

    private fun assemble(u: DriveUpload, out: File): Pair<String, Long> {
        val md = MessageDigest.getInstance("SHA-256")
        var total = 0L
        out.outputStream().use { os ->
            val buf = ByteArray(64 * 1024)
            for (i in 0 until u.totalChunks) {
                val cf = File(chunksDir(u.id), "$i.bin")
                cf.inputStream().use { ins ->
                    while (true) {
                        val r = ins.read(buf)
                        if (r < 0) break
                        os.write(buf, 0, r)
                        md.update(buf, 0, r)
                        total += r
                    }
                }
            }
            os.flush()
        }
        val sb = StringBuilder()
        for (b in md.digest()) sb.append("%02x".format(b.toInt() and 0xff))
        return sb.toString() to total
    }

    private fun findOrThrow(id: String): DriveUpload {
        val u = DataAccessUtils.singleResult(jdbc.query(
            "SELECT * FROM drive_uploads WHERE id = :id",
            mapOf("id" to id),
        ) { rs, _ ->
            DriveUpload(
                id = rs.getString("id"),
                parentId = rs.getObject("parent_id")?.let { (it as Number).toLong() },
                name = rs.getString("name"),
                size = rs.getLong("size"),
                chunkSize = rs.getLong("chunk_size"),
                totalChunks = rs.getInt("total_chunks"),
                receivedMask = rs.getBytes("received_mask") ?: ByteArray(0),
                status = rs.getString("status"),
                expiresAt = rs.getLong("expires_at"),
                createdAt = rs.getLong("created_at"),
                updatedAt = rs.getLong("updated_at"),
            )
        }) ?: throw NotFoundException("upload not found")
        if (u.expiresAt < System.currentTimeMillis()) throw NotFoundException("upload expired")
        return u
    }

    companion object {
        private const val UPLOAD_TTL_MS = 24L * 60 * 60 * 1000
        private const val MAX_FILE_SIZE = 4L shl 30
        private const val DEFAULT_CHUNK = 8L shl 20

        fun decodeMask(mask: ByteArray, total: Int): List<Int> {
            val out = ArrayList<Int>()
            for (i in 0 until total) {
                if (i / 8 >= mask.size) break
                if ((mask[i / 8].toInt() and (1 shl (i % 8))) != 0) out.add(i)
            }
            return out
        }
    }
}
