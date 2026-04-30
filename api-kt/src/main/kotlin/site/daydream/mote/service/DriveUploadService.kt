package site.daydream.mote.service

import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.impl.DSL
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.ConflictException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.generated.Tables.DRIVE_UPLOADS
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
    private val dsl: DSLContext,
    private val driveService: DriveService,
    private val uploadConfig: UploadConfig,
    txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    // drive_uploads.id is TEXT in the DB but codegen forced it to BIGINT; use a raw string-typed field.
    private val UPLOAD_ID = DSL.field(DSL.name("id"), String::class.java)

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
            dsl.insertInto(DRIVE_UPLOADS)
                .set(UPLOAD_ID, id)
                .set(DRIVE_UPLOADS.PARENT_ID, req.parentId)
                .set(DRIVE_UPLOADS.NAME, req.name)
                .set(DRIVE_UPLOADS.SIZE, req.size)
                .set(DRIVE_UPLOADS.CHUNK_SIZE, chunk)
                .set(DRIVE_UPLOADS.TOTAL_CHUNKS, total)
                .set(DRIVE_UPLOADS.RECEIVED_MASK, mask)
                .set(DRIVE_UPLOADS.STATUS, "uploading")
                .set(DRIVE_UPLOADS.EXPIRES_AT, expiresAt)
                .set(DRIVE_UPLOADS.CREATED_AT, now)
                .set(DRIVE_UPLOADS.UPDATED_AT, now)
                .execute()
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
            val cur = dsl.select(DRIVE_UPLOADS.RECEIVED_MASK)
                .from(DRIVE_UPLOADS)
                .where(UPLOAD_ID.eq(id))
                .fetchOne()
                ?.get(DRIVE_UPLOADS.RECEIVED_MASK)
                ?: throw NotFoundException("upload not found")
            if (idx / 8 >= cur.size) throw BadRequestException("invalid chunk index")
            cur[idx / 8] = (cur[idx / 8].toInt() or (1 shl (idx % 8))).toByte()
            dsl.update(DRIVE_UPLOADS)
                .set(DRIVE_UPLOADS.RECEIVED_MASK, cur)
                .set(DRIVE_UPLOADS.UPDATED_AT, System.currentTimeMillis())
                .where(UPLOAD_ID.eq(id))
                .execute()
        }
    }

    fun complete(id: String, onCollision: String): DriveNode {
        val u = findOrThrow(id)
        val updated = dsl.update(DRIVE_UPLOADS)
            .set(DRIVE_UPLOADS.STATUS, "assembling")
            .set(DRIVE_UPLOADS.UPDATED_AT, System.currentTimeMillis())
            .where(UPLOAD_ID.eq(id))
            .and(DRIVE_UPLOADS.STATUS.eq("uploading"))
            .execute()
        if (updated == 0) throw BadRequestException("invalid upload state")

        try {
            val mask = dsl.select(DRIVE_UPLOADS.RECEIVED_MASK)
                .from(DRIVE_UPLOADS)
                .where(UPLOAD_ID.eq(id))
                .fetchOne()
                ?.get(DRIVE_UPLOADS.RECEIVED_MASK)
                ?: throw NotFoundException("upload not found")
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
            dsl.update(DRIVE_UPLOADS)
                .set(DRIVE_UPLOADS.STATUS, "uploading")
                .where(UPLOAD_ID.eq(id))
                .execute()
            throw e
        }
    }

    fun cancel(id: String) {
        val n = dsl.deleteFrom(DRIVE_UPLOADS)
            .where(UPLOAD_ID.eq(id))
            .and(DRIVE_UPLOADS.STATUS.eq("uploading"))
            .execute()
        if (n > 0) chunksDir(id).deleteRecursively()
    }

    fun purgeExpired(): Int {
        val ids = dsl.select(UPLOAD_ID)
            .from(DRIVE_UPLOADS)
            .where(DRIVE_UPLOADS.EXPIRES_AT.lt(System.currentTimeMillis()))
            .fetch { it.get(UPLOAD_ID)!! }
        ids.forEach { deleteSession(it) }
        return ids.size
    }

    private fun deleteSession(id: String) {
        dsl.deleteFrom(DRIVE_UPLOADS).where(UPLOAD_ID.eq(id)).execute()
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
        val rec: Record = dsl.select(
            UPLOAD_ID,
            DRIVE_UPLOADS.PARENT_ID,
            DRIVE_UPLOADS.NAME,
            DRIVE_UPLOADS.SIZE,
            DRIVE_UPLOADS.CHUNK_SIZE,
            DRIVE_UPLOADS.TOTAL_CHUNKS,
            DRIVE_UPLOADS.RECEIVED_MASK,
            DRIVE_UPLOADS.STATUS,
            DRIVE_UPLOADS.EXPIRES_AT,
            DRIVE_UPLOADS.CREATED_AT,
            DRIVE_UPLOADS.UPDATED_AT,
        )
            .from(DRIVE_UPLOADS)
            .where(UPLOAD_ID.eq(id))
            .fetchOne()
            ?: throw NotFoundException("upload not found")
        val u = DriveUpload(
            id = rec.get(UPLOAD_ID)!!,
            parentId = rec.get(DRIVE_UPLOADS.PARENT_ID),
            name = rec.get(DRIVE_UPLOADS.NAME)!!,
            size = rec.get(DRIVE_UPLOADS.SIZE)!!,
            chunkSize = rec.get(DRIVE_UPLOADS.CHUNK_SIZE)!!,
            totalChunks = rec.get(DRIVE_UPLOADS.TOTAL_CHUNKS)!!,
            receivedMask = rec.get(DRIVE_UPLOADS.RECEIVED_MASK) ?: ByteArray(0),
            status = rec.get(DRIVE_UPLOADS.STATUS)!!,
            expiresAt = rec.get(DRIVE_UPLOADS.EXPIRES_AT)!!,
            createdAt = rec.get(DRIVE_UPLOADS.CREATED_AT)!!,
            updatedAt = rec.get(DRIVE_UPLOADS.UPDATED_AT)!!,
        )
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
