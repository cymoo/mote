package site.daydream.mote.service

import org.jooq.DSLContext
import org.jooq.Record
import org.jooq.exception.IntegrityConstraintViolationException
import org.jooq.impl.DSL
import org.springframework.dao.DuplicateKeyException
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionTemplate
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.ConflictException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.generated.Tables.DRIVE_NODES
import site.daydream.mote.generated.Tables.DRIVE_SHARES
import site.daydream.mote.model.DriveBreadcrumb
import site.daydream.mote.model.DriveNode
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.security.SecureRandom
import java.util.UUID

@Service
class DriveService(
    private val dsl: DSLContext,
    private val uploadConfig: UploadConfig,
    private val driveThumbService: DriveThumbServiceProvider, // forward ref to avoid cycle
    txManager: PlatformTransactionManager,
) {
    private val tx = TransactionTemplate(txManager)

    init {
        Files.createDirectories(Paths.get(uploadConfig.uploadDir, "drive"))
        Files.createDirectories(Paths.get(uploadConfig.uploadDir, "drive", "_chunks"))
    }

    fun blobAbsPath(rel: String): String =
        Paths.get(uploadConfig.uploadDir, rel).toString()

    fun blobAbsFile(rel: String): File = File(blobAbsPath(rel))

    /** Returns a node (deleted or not). Throws NotFoundException if missing. */
    fun findById(id: Long): DriveNode =
        dsl.selectFrom(DRIVE_NODES).where(DRIVE_NODES.ID.eq(id)).fetchOne()
            ?.let { mapNodeRecord(it) }
            ?: throw NotFoundException("drive node not found")

    fun findByIdOrNull(id: Long): DriveNode? = try {
        findById(id)
    } catch (_: NotFoundException) {
        null
    }

    /** Active sibling lookup (case-insensitive). */
    fun findActiveSibling(parentId: Long?, name: String): DriveNode? =
        dsl.selectFrom(DRIVE_NODES)
            .where("COALESCE(parent_id, 0) = COALESCE(?, 0)", parentId)
            .and(DSL.lower(DRIVE_NODES.NAME).eq(name.lowercase()))
            .and(DRIVE_NODES.DELETED_AT.isNull)
            .fetchOne()
            ?.let { mapNodeRecord(it) }

    @Transactional(readOnly = true)
    fun list(parentId: Long?, query: String?, orderBy: String?, sort: String?): List<DriveNode> {
        val hasQuery = !query.isNullOrBlank()

        var condition = if (hasQuery) {
            val pattern = "%" + likeEscape(query!!.trim().lowercase()) + "%"
            DRIVE_NODES.DELETED_AT.isNull
                .and(DSL.lower(DRIVE_NODES.NAME).like(pattern).escape('\\'))
        } else if (parentId == null) {
            DRIVE_NODES.PARENT_ID.isNull.and(DRIVE_NODES.DELETED_AT.isNull)
        } else {
            requireActiveFolder(parentId)
            DRIVE_NODES.PARENT_ID.eq(parentId).and(DRIVE_NODES.DELETED_AT.isNull)
        }

        val col = when (orderBy) {
            "size" -> DRIVE_NODES.SIZE as org.jooq.Field<*>
            "updated_at" -> DRIVE_NODES.UPDATED_AT as org.jooq.Field<*>
            "created_at" -> DRIVE_NODES.CREATED_AT as org.jooq.Field<*>
            else -> DSL.lower(DRIVE_NODES.NAME) as org.jooq.Field<*>
        }
        val sortField = if (sort.equals("desc", ignoreCase = true)) col.desc() else col.asc()

        val nodes = dsl.selectFrom(DRIVE_NODES)
            .where(condition)
            .orderBy(
                DSL.case_().`when`(DRIVE_NODES.TYPE.eq("folder"), 0).otherwise(1),
                sortField,
                DRIVE_NODES.ID.asc(),
            )
            .fetch { mapNodeRecord(it) }.toMutableList()

        if (nodes.isEmpty()) return nodes
        val withPaths = if (hasQuery) populatePaths(nodes) else nodes
        return populateShareCounts(withPaths)
    }

    private fun populatePaths(nodes: List<DriveNode>): List<DriveNode> {
        val cache = HashMap<Long, String>()
        return nodes.map { n ->
            if (n.parentId == null) n
            else {
                val path = cache.getOrPut(n.parentId) {
                    breadcrumbs(n.parentId).joinToString("/") { it.name }
                }
                n.copy(path = path)
            }
        }
    }

    // Keep as raw SQL: dynamic IN clause over fileIds.
    private fun populateShareCounts(nodes: List<DriveNode>): List<DriveNode> {
        val fileIds = nodes.filter { it.type == "file" }.map { it.id }
        if (fileIds.isEmpty()) return nodes
        val now = System.currentTimeMillis()
        val placeholders = fileIds.joinToString(",") { "?" }
        val rows = dsl.resultQuery(
            """
            SELECT node_id AS nid, COUNT(*) AS c FROM drive_shares
            WHERE node_id IN ($placeholders) AND (expires_at IS NULL OR expires_at > ?)
            GROUP BY node_id
            """.trimIndent(),
            *fileIds.map { it as Any? }.toTypedArray(), now,
        ).fetch { rec -> rec.get("nid", Long::class.java) to rec.get("c", Int::class.java) }
        if (rows.isEmpty()) return nodes
        val map = rows.toMap()
        return nodes.map { if (map.containsKey(it.id)) it.copy(shareCount = map[it.id]!!) else it }
    }

    fun listTrash(): List<DriveNode> {
        val sql = """
            SELECT n.* FROM drive_nodes n
            WHERE n.deleted_at IS NOT NULL
              AND (
                n.parent_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM drive_nodes p
                  WHERE p.id = n.parent_id
                    AND p.deleted_at IS NOT NULL
                    AND p.delete_batch_id = n.delete_batch_id
                )
              )
            ORDER BY n.deleted_at DESC, n.id DESC
        """.trimIndent()
        return dsl.resultQuery(sql).fetch { rec -> mapNodeFromRecord(rec) }
    }

    // Keep as raw SQL: recursive CTE.
    fun breadcrumbs(id: Long): List<DriveBreadcrumb> {
        val sql = """
            WITH RECURSIVE chain(id, name, parent_id, depth) AS (
              SELECT id, name, parent_id, 0 FROM drive_nodes WHERE id = ?
              UNION ALL
              SELECT n.id, n.name, n.parent_id, c.depth + 1
              FROM drive_nodes n JOIN chain c ON n.id = c.parent_id
            )
            SELECT id, name, depth FROM chain ORDER BY depth DESC
        """.trimIndent()
        return dsl.resultQuery(sql, id).fetch { rec ->
            DriveBreadcrumb(rec.get("id", Long::class.java), rec.get("name", String::class.java))
        }
    }

    @Transactional
    fun createFolder(parentId: Long?, name: String): DriveNode {
        validateName(name)
        if (parentId != null) requireActiveFolder(parentId)
        val now = System.currentTimeMillis()
        val id = try {
            dsl.insertInto(DRIVE_NODES)
                .set(DRIVE_NODES.PARENT_ID, parentId)
                .set(DRIVE_NODES.TYPE, "folder")
                .set(DRIVE_NODES.NAME, name)
                .set(DRIVE_NODES.CREATED_AT, now)
                .set(DRIVE_NODES.UPDATED_AT, now)
                .returningResult(DRIVE_NODES.ID)
                .fetchOne()!!.value1()
        } catch (e: Exception) {
            throw mapUniqueOrRethrow(e)
        }
        return findById(id)
    }

    @Transactional
    fun rename(id: Long, newName: String) {
        validateName(newName)
        val now = System.currentTimeMillis()
        val n = try {
            dsl.update(DRIVE_NODES)
                .set(DRIVE_NODES.NAME, newName)
                .set(DRIVE_NODES.UPDATED_AT, now)
                .where(DRIVE_NODES.ID.eq(id))
                .and(DRIVE_NODES.DELETED_AT.isNull)
                .execute()
        } catch (e: Exception) {
            throw mapUniqueOrRethrow(e)
        }
        if (n == 0) throw NotFoundException("drive node not found")
    }

    @Transactional
    fun move(ids: List<Long>, newParentId: Long?) {
        if (ids.isEmpty()) return
        if (newParentId != null) {
            val parent = findByIdOrNull(newParentId)
                ?: throw BadRequestException("invalid parent folder")
            if (parent.deletedAt != null) throw BadRequestException("invalid parent folder")
            if (parent.type != "folder") throw BadRequestException("parent must be a folder")
        }
        val now = System.currentTimeMillis()
        for (id in ids) {
            if (newParentId != null && newParentId == id) {
                throw BadRequestException("cannot move folder into its own descendant")
            }
            if (newParentId != null) {
                // Keep as raw SQL: recursive CTE descendant check.
                val hit = dsl.fetchOne(
                    """
                    WITH RECURSIVE descendants(id) AS (
                      SELECT id FROM drive_nodes WHERE id = ?
                      UNION ALL
                      SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
                    )
                    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?)
                    """.trimIndent(),
                    id, newParentId,
                )?.get(0, Int::class.java) ?: 0
                if (hit == 1) throw BadRequestException("cannot move folder into its own descendant")
            }
            try {
                dsl.update(DRIVE_NODES)
                    .set(DRIVE_NODES.PARENT_ID, newParentId)
                    .set(DRIVE_NODES.UPDATED_AT, now)
                    .where(DRIVE_NODES.ID.eq(id))
                    .and(DRIVE_NODES.DELETED_AT.isNull)
                    .execute()
            } catch (e: Exception) {
                throw mapUniqueOrRethrow(e)
            }
        }
    }

    @Transactional
    fun softDelete(ids: List<Long>) {
        if (ids.isEmpty()) return
        val batch = randomHex(16)
        val now = System.currentTimeMillis()
        // Keep as raw SQL: recursive CTE subtree update.
        for (id in ids) {
            dsl.execute(
                """
                WITH RECURSIVE subtree(id) AS (
                  SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
                  UNION ALL
                  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
                  WHERE n.deleted_at IS NULL
                )
                UPDATE drive_nodes
                SET deleted_at = ?, delete_batch_id = ?, updated_at = ?
                WHERE id IN (SELECT id FROM subtree)
                """.trimIndent(),
                id, now, batch, now,
            )
        }
    }

    @Transactional
    fun restore(id: Long) {
        val n = findById(id)
        if (n.deletedAt == null) return
        if (n.deleteBatchId == null) {
            val hit = dsl.fetchOne(
                """
                SELECT EXISTS(
                  SELECT 1 FROM drive_nodes
                  WHERE COALESCE(parent_id, 0) = COALESCE(?, 0)
                    AND LOWER(name) = LOWER(?)
                    AND deleted_at IS NULL
                )
                """.trimIndent(),
                n.parentId, n.name,
            )?.get(0, Int::class.java) ?: 0
            if (hit == 1) throw ConflictException("name already exists in this folder")
            dsl.execute(
                "UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL WHERE id = ?",
                id,
            )
            return
        }

        val conflicts = dsl.fetchOne(
            """
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
              UNION ALL
              SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
              WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
            )
            SELECT COUNT(*)
            FROM drive_nodes r
            WHERE r.id IN (SELECT id FROM subtree)
              AND EXISTS (
                SELECT 1 FROM drive_nodes a
                WHERE COALESCE(a.parent_id, 0) = COALESCE(r.parent_id, 0)
                  AND LOWER(a.name) = LOWER(r.name)
                  AND a.deleted_at IS NULL
                  AND a.id NOT IN (SELECT id FROM subtree)
              )
            """.trimIndent(),
            id, n.deleteBatchId,
        )?.get(0, Int::class.java) ?: 0
        if (conflicts > 0) throw ConflictException("name already exists in this folder")

        dsl.execute(
            """
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM drive_nodes WHERE id = ? AND deleted_at IS NOT NULL
              UNION ALL
              SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
              WHERE n.deleted_at IS NOT NULL AND n.delete_batch_id = ?
            )
            UPDATE drive_nodes
            SET deleted_at = NULL, delete_batch_id = NULL
            WHERE id IN (SELECT id FROM subtree)
            """.trimIndent(),
            id, n.deleteBatchId,
        )
    }

    fun purge(ids: List<Long>) {
        for (id in ids) purgeOne(id)
    }

    private fun purgeOne(id: Long) {
        // Blobs can be shared by rows outside this subtree (copies, deduplicated
        // uploads). Decide which blobs became orphans INSIDE the tx — SQLite's
        // single writer serializes this against a concurrent copy — but remove
        // files only after commit so a rollback can't have deleted live data.
        val orphans = tx.execute {
            // Keep as raw SQL: recursive CTE to collect the full subtree.
            val rows = dsl.resultQuery(
                """
                WITH RECURSIVE subtree(id) AS (
                  SELECT id FROM drive_nodes WHERE id = ?
                  UNION ALL
                  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
                )
                SELECT n.id, n.blob_path FROM drive_nodes n WHERE n.id IN (SELECT id FROM subtree)
                """.trimIndent(),
                id,
            ).fetch { rec -> rec.get("id", Long::class.java) to rec.get("blob_path", String::class.java) }
            if (rows.isEmpty()) throw NotFoundException("drive node not found")

            // Delete the whole subtree explicitly (don't rely on FK cascade — test profile may have FK off).
            val subtreeIds = rows.map { it.first }
            dsl.deleteFrom(DRIVE_NODES).where(DRIVE_NODES.ID.`in`(subtreeIds)).execute()

            rows.mapNotNull { it.second }.filter { it.isNotBlank() }.distinct()
                .filter { blob -> dsl.fetchCount(DRIVE_NODES, DRIVE_NODES.BLOB_PATH.eq(blob)) == 0 }
        }!!
        for (blob in orphans) {
            runCatching { File(blobAbsPath(blob)).delete() }
            driveThumbService.purgeThumb(blob)
        }
    }

    /**
     * Hard-deletes nodes trashed before [cutoff] (epoch-ms) — the topmost
     * deleted batch roots and all their descendants — and removes blob files
     * that became orphans along with their cached thumbnails. Returns the
     * number of purged rows.
     */
    fun purgeTrashOlderThan(cutoff: Long): Int {
        // Keep as raw SQL: recursive CTE over deleted batch roots + descendants.
        val rows = dsl.resultQuery(
            """
            WITH RECURSIVE trash(id) AS (
              SELECT id FROM drive_nodes
              WHERE deleted_at IS NOT NULL AND deleted_at < ?
                AND (
                  parent_id IS NULL
                  OR NOT EXISTS (
                    SELECT 1 FROM drive_nodes p
                    WHERE p.id = drive_nodes.parent_id
                      AND p.deleted_at IS NOT NULL
                      AND p.delete_batch_id = drive_nodes.delete_batch_id
                  )
                )
              UNION ALL
              SELECT n.id FROM drive_nodes n JOIN trash t ON n.parent_id = t.id
            )
            SELECT n.id, n.blob_path FROM drive_nodes n WHERE n.id IN (SELECT id FROM trash)
            """.trimIndent(),
            cutoff,
        ).fetch { rec -> rec.get("id", Long::class.java) to rec.get("blob_path", String::class.java) }
        if (rows.isEmpty()) return 0

        dsl.deleteFrom(DRIVE_NODES).where(DRIVE_NODES.ID.`in`(rows.map { it.first })).execute()

        // Blobs may still be referenced by rows outside the purged set (copies,
        // deduplicated uploads) — only remove files that became orphans, along
        // with their cached thumbnails.
        rows.mapNotNull { it.second }.filter { it.isNotBlank() }.distinct()
            .forEach { removeBlobIfOrphan(it) }
        return rows.size
    }

    /**
     * Removes the blob file and its cached thumbnail when no drive_nodes row
     * (active or trashed) references [blobPath] anymore. Blobs can be shared
     * by several rows (copies, deduplicated uploads), so removal must always
     * be gated on this check. Call it AFTER the rows that dropped the
     * reference have been committed.
     */
    fun removeBlobIfOrphan(blobPath: String) {
        if (blobPath.isBlank()) return
        val refs = try {
            dsl.fetchCount(DRIVE_NODES, DRIVE_NODES.BLOB_PATH.eq(blobPath))
        } catch (_: Exception) {
            return
        }
        if (refs > 0) return
        runCatching { File(blobAbsPath(blobPath)).delete() }
        driveThumbService.purgeThumb(blobPath)
    }

    /**
     * Returns the blob_path of an existing node (active or trashed) with the
     * same content hash and size whose file is still present on disk, or null
     * when there is none. Used to deduplicate uploads.
     */
    fun findReusableBlob(hash: String?, size: Long): String? {
        if (hash.isNullOrEmpty()) return null
        return dsl.selectDistinct(DRIVE_NODES.BLOB_PATH)
            .from(DRIVE_NODES)
            .where(DRIVE_NODES.HASH.eq(hash))
            .and(DRIVE_NODES.SIZE.eq(size))
            .and(DRIVE_NODES.BLOB_PATH.isNotNull)
            .limit(8)
            .fetch { it.value1() }
            .firstOrNull { !it.isNullOrBlank() && File(blobAbsPath(it)).exists() }
    }

    data class DescendantRow(
        val id: Long,
        val type: String,
        val name: String,
        val blobPath: String?,
        val relPath: String,
    )

    // Keep as raw SQL: recursive CTE.
    fun collectDescendants(rootId: Long): List<DescendantRow> {
        val sql = """
            WITH RECURSIVE subtree(id, type, name, blob_path, rel_path) AS (
              SELECT id, type, name, blob_path, name AS rel_path
              FROM drive_nodes WHERE id = ? AND deleted_at IS NULL
              UNION ALL
              SELECT n.id, n.type, n.name, n.blob_path, s.rel_path || '/' || n.name
              FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
              WHERE n.deleted_at IS NULL
            )
            SELECT id, type, name, blob_path, rel_path FROM subtree
        """.trimIndent()
        return dsl.resultQuery(sql, rootId).fetch { rec ->
            DescendantRow(
                rec.get("id", Long::class.java),
                rec.get("type", String::class.java),
                rec.get("name", String::class.java),
                rec.get("blob_path", String::class.java),
                rec.get("rel_path", String::class.java),
            )
        }
    }

    fun requireActiveFolder(id: Long): DriveNode {
        val n = findById(id)
        if (n.deletedAt != null) throw NotFoundException("drive node not found")
        if (n.type != "folder") throw BadRequestException("parent must be a folder")
        return n
    }

    /** Insert a new file row. Caller has already written the blob. */
    @Transactional
    fun createFileNode(parentId: Long?, name: String, blobPath: String, hash: String?, size: Long): DriveNode {
        validateName(name)
        if (parentId != null) requireActiveFolder(parentId)
        val now = System.currentTimeMillis()
        val id = try {
            dsl.insertInto(DRIVE_NODES)
                .set(DRIVE_NODES.PARENT_ID, parentId)
                .set(DRIVE_NODES.TYPE, "file")
                .set(DRIVE_NODES.NAME, name)
                .set(DRIVE_NODES.BLOB_PATH, blobPath)
                .set(DRIVE_NODES.SIZE, size)
                .set(DRIVE_NODES.HASH, if (hash.isNullOrEmpty()) null else hash)
                .set(DRIVE_NODES.CREATED_AT, now)
                .set(DRIVE_NODES.UPDATED_AT, now)
                .returningResult(DRIVE_NODES.ID)
                .fetchOne()!!.value1()
        } catch (e: Exception) {
            throw mapUniqueOrRethrow(e)
        }
        return findById(id)
    }

    /** Replace an existing same-name file ("overwrite" collision strategy). */
    fun replaceFileNode(parentId: Long?, name: String, blobPath: String, hash: String?, size: Long): DriveNode {
        validateName(name)
        var oldBlob: String? = null
        val nodeId = tx.execute {
            val existing = findActiveSibling(parentId, name)
            if (existing == null || existing.type != "file") {
                // Nothing to overwrite (or existing is a folder); insert fresh.
                createFileNode(parentId, name, blobPath, hash, size).id
            } else {
                oldBlob = existing.blobPath
                dsl.update(DRIVE_NODES)
                    .set(DRIVE_NODES.BLOB_PATH, blobPath)
                    .set(DRIVE_NODES.SIZE, size)
                    .set(DRIVE_NODES.HASH, if (hash.isNullOrEmpty()) null else hash)
                    .set(DRIVE_NODES.UPDATED_AT, System.currentTimeMillis())
                    .where(DRIVE_NODES.ID.eq(existing.id))
                    .execute()
                existing.id
            }
        }!!
        // The previous blob may still back other rows (copies, deduplicated
        // uploads) — or be the very blob we just reused; only remove orphans,
        // and only after the reference drop has been committed.
        oldBlob?.let { if (it.isNotBlank() && it != blobPath) removeBlobIfOrphan(it) }
        return findById(nodeId)
    }

    /** Generate a non-conflicting filename (e.g. "report.pdf" -> "report (1).pdf"). */
    fun autoRename(parentId: Long?, name: String): String {
        if (findActiveSibling(parentId, name) == null) return name
        val dot = name.lastIndexOf('.')
        val (stem, ext) = if (dot <= 0) name to "" else name.substring(0, dot) to name.substring(dot)

        val prefix = likeEscape(stem) + " (%"
        val suffix = "%)" + likeEscape(ext)

        val rows = dsl.selectFrom(DRIVE_NODES)
            .where("COALESCE(parent_id, 0) = COALESCE(?, 0)", parentId)
            .and(DRIVE_NODES.DELETED_AT.isNull)
            .and(DRIVE_NODES.NAME.like(prefix).escape('\\'))
            .and(DRIVE_NODES.NAME.like(suffix).escape('\\'))
            .fetch { it.get(DRIVE_NODES.NAME)!! }

        var maxN = 0
        for (n in rows) {
            val mid = if (ext.isNotEmpty() && n.endsWith(ext)) n.substring(0, n.length - ext.length) else n
            val i = mid.lastIndexOf(" (")
            if (i < 0) continue
            val num = mid.substring(i + 2).removeSuffix(")")
            num.toIntOrNull()?.let { if (it > maxN) maxN = it }
        }
        return "$stem (${maxN + 1})$ext"
    }

    // ---------- helpers ----------

    private fun mapNodeRecord(rec: Record): DriveNode = DriveNode(
        id = rec.get(DRIVE_NODES.ID)!!,
        parentId = rec.get(DRIVE_NODES.PARENT_ID),
        type = rec.get(DRIVE_NODES.TYPE)!!,
        name = rec.get(DRIVE_NODES.NAME)!!,
        blobPath = rec.get(DRIVE_NODES.BLOB_PATH),
        size = rec.get(DRIVE_NODES.SIZE),
        hash = rec.get(DRIVE_NODES.HASH),
        deletedAt = rec.get(DRIVE_NODES.DELETED_AT),
        deleteBatchId = rec.get(DRIVE_NODES.DELETE_BATCH_ID),
        createdAt = rec.get(DRIVE_NODES.CREATED_AT)!!,
        updatedAt = rec.get(DRIVE_NODES.UPDATED_AT)!!,
    )

    /** Maps a record from a raw SQL query (column names without table prefix). */
    private fun mapNodeFromRecord(rec: Record): DriveNode = DriveNode(
        id = rec.get("id", Long::class.java),
        parentId = rec.get("parent_id", Long::class.javaObjectType),
        type = rec.get("type", String::class.java),
        name = rec.get("name", String::class.java),
        blobPath = rec.get("blob_path", String::class.java),
        size = rec.get("size", Long::class.javaObjectType),
        hash = rec.get("hash", String::class.java),
        deletedAt = rec.get("deleted_at", Long::class.javaObjectType),
        deleteBatchId = rec.get("delete_batch_id", String::class.java),
        createdAt = rec.get("created_at", Long::class.java),
        updatedAt = rec.get("updated_at", Long::class.java),
    )

    private fun mapUniqueOrRethrow(e: Exception): RuntimeException {
        if (isUniqueConstraint(e)) return ConflictException("name already exists in this folder")
        return if (e is RuntimeException) e else RuntimeException(e)
    }

    private fun isUniqueConstraint(e: Throwable?): Boolean {
        var cur: Throwable? = e
        while (cur != null) {
            val msg = cur.message ?: ""
            if (msg.contains("UNIQUE constraint", ignoreCase = true)) return true
            if (cur is DuplicateKeyException) return true
            if (cur is IntegrityConstraintViolationException) return true
            cur = cur.cause
        }
        return false
    }

    companion object {
        fun likeEscape(s: String): String =
            s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

        fun validateName(name: String) {
            val n = name.trim()
            if (n.isEmpty() || n == "." || n == "..") throw BadRequestException("invalid name")
            if (n.contains('/') || n.contains('\\')) throw BadRequestException("invalid name")
            if (n.length > 255) throw BadRequestException("invalid name")
        }

        private val RAND = SecureRandom()

        fun randomHex(nBytes: Int): String {
            val b = ByteArray(nBytes)
            RAND.nextBytes(b)
            val sb = StringBuilder(nBytes * 2)
            for (x in b) sb.append("%02x".format(x.toInt() and 0xff))
            return sb.toString()
        }

        fun newBlobName(originalName: String): String {
            val dot = originalName.lastIndexOf('.')
            val ext = if (dot < 0) "" else originalName.substring(dot).lowercase()
            val id = UUID.randomUUID().toString().replace("-", "")
            return id + ext
        }
    }
}

/** Tiny interface so DriveService can call thumb-purge without a circular @Service dep. */
interface DriveThumbServiceProvider {
    fun purgeThumb(blobPath: String)
}
