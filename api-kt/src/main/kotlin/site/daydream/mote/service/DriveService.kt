package site.daydream.mote.service

import org.springframework.dao.DuplicateKeyException
import org.springframework.dao.support.DataAccessUtils
import org.springframework.jdbc.core.RowMapper
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import site.daydream.mote.config.UploadConfig
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.ConflictException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveBreadcrumb
import site.daydream.mote.model.DriveNode
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.security.SecureRandom
import java.sql.ResultSet
import java.util.UUID

@Service
class DriveService(
    private val jdbc: NamedParameterJdbcTemplate,
    private val uploadConfig: UploadConfig,
    private val driveThumbService: DriveThumbServiceProvider, // forward ref to avoid cycle
) {
    init {
        Files.createDirectories(Paths.get(uploadConfig.uploadDir, "drive"))
        Files.createDirectories(Paths.get(uploadConfig.uploadDir, "drive", "_chunks"))
    }

    private val nodeMapper: RowMapper<DriveNode> = RowMapper { rs, _ -> mapNode(rs) }

    fun blobAbsPath(rel: String): String =
        Paths.get(uploadConfig.uploadDir, rel).toString()

    fun blobAbsFile(rel: String): File = File(blobAbsPath(rel))

    /** Returns a node (deleted or not). Throws NotFoundException if missing. */
    fun findById(id: Long): DriveNode {
        val rows = jdbc.query(
            "SELECT * FROM drive_nodes WHERE id = :id",
            mapOf("id" to id),
            nodeMapper,
        )
        return rows.firstOrNull() ?: throw NotFoundException("drive node not found")
    }

    fun findByIdOrNull(id: Long): DriveNode? = try {
        findById(id)
    } catch (_: NotFoundException) {
        null
    }

    /** Active sibling lookup (case-insensitive). */
    fun findActiveSibling(parentId: Long?, name: String): DriveNode? {
        val rows = jdbc.query(
            """
            SELECT * FROM drive_nodes
            WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0)
              AND LOWER(name) = LOWER(:name)
              AND deleted_at IS NULL
            """.trimIndent(),
            mapOf("pid" to parentId, "name" to name),
            nodeMapper,
        )
        return rows.firstOrNull()
    }

    @Transactional(readOnly = true)
    fun list(parentId: Long?, query: String?, orderBy: String?, sort: String?): List<DriveNode> {
        val hasQuery = !query.isNullOrBlank()
        val params = MapSqlParameterSource()
        val where: String

        if (hasQuery) {
            val pattern = "%" + likeEscape(query!!.trim().lowercase()) + "%"
            params.addValue("pattern", pattern)
            where = "deleted_at IS NULL AND LOWER(name) LIKE :pattern ESCAPE '\\'"
        } else if (parentId == null) {
            where = "parent_id IS NULL AND deleted_at IS NULL"
        } else {
            requireActiveFolder(parentId)
            params.addValue("pid", parentId)
            where = "parent_id = :pid AND deleted_at IS NULL"
        }

        val col = when (orderBy) {
            "size" -> "size"
            "updated_at" -> "updated_at"
            "created_at" -> "created_at"
            else -> "LOWER(name)"
        }
        val dir = if (sort.equals("desc", ignoreCase = true)) "DESC" else "ASC"

        val sql = """
            SELECT * FROM drive_nodes WHERE $where
            ORDER BY CASE WHEN type = 'folder' THEN 0 ELSE 1 END, $col $dir, id ASC
        """.trimIndent()

        val nodes = jdbc.query(sql, params, nodeMapper).toMutableList()
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

    private fun populateShareCounts(nodes: List<DriveNode>): List<DriveNode> {
        val fileIds = nodes.filter { it.type == "file" }.map { it.id }
        if (fileIds.isEmpty()) return nodes
        val now = System.currentTimeMillis()
        val rows = jdbc.query(
            """
            SELECT node_id AS nid, COUNT(*) AS c FROM drive_shares
            WHERE node_id IN (:ids) AND (expires_at IS NULL OR expires_at > :now)
            GROUP BY node_id
            """.trimIndent(),
            mapOf("ids" to fileIds, "now" to now),
        ) { rs, _ -> rs.getLong("nid") to rs.getInt("c") }
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
        return jdbc.query(sql, emptyMap<String, Any>(), nodeMapper)
    }

    fun breadcrumbs(id: Long): List<DriveBreadcrumb> {
        val sql = """
            WITH RECURSIVE chain(id, name, parent_id, depth) AS (
              SELECT id, name, parent_id, 0 FROM drive_nodes WHERE id = :id
              UNION ALL
              SELECT n.id, n.name, n.parent_id, c.depth + 1
              FROM drive_nodes n JOIN chain c ON n.id = c.parent_id
            )
            SELECT id, name, depth FROM chain ORDER BY depth DESC
        """.trimIndent()
        return jdbc.query(sql, mapOf("id" to id)) { rs, _ ->
            DriveBreadcrumb(rs.getLong("id"), rs.getString("name"))
        }
    }

    @Transactional
    fun createFolder(parentId: Long?, name: String): DriveNode {
        validateName(name)
        if (parentId != null) requireActiveFolder(parentId)
        val now = System.currentTimeMillis()
        val id = try {
            jdbc.queryForObject(
                """
                INSERT INTO drive_nodes (parent_id, type, name, created_at, updated_at)
                VALUES (:pid, 'folder', :name, :now, :now) RETURNING id
                """.trimIndent(),
                mapOf("pid" to parentId, "name" to name, "now" to now),
                Long::class.java,
            )!!
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
            jdbc.update(
                """
                UPDATE drive_nodes SET name = :name, updated_at = :now
                WHERE id = :id AND deleted_at IS NULL
                """.trimIndent(),
                mapOf("id" to id, "name" to newName, "now" to now),
            )
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
                val hit = jdbc.queryForObject(
                    """
                    WITH RECURSIVE descendants(id) AS (
                      SELECT id FROM drive_nodes WHERE id = :id
                      UNION ALL
                      SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
                    )
                    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = :np)
                    """.trimIndent(),
                    mapOf("id" to id, "np" to newParentId),
                    Int::class.java,
                ) ?: 0
                if (hit == 1) throw BadRequestException("cannot move folder into its own descendant")
            }
            try {
                jdbc.update(
                    """
                    UPDATE drive_nodes SET parent_id = :pid, updated_at = :now
                    WHERE id = :id AND deleted_at IS NULL
                    """.trimIndent(),
                    mapOf("pid" to newParentId, "now" to now, "id" to id),
                )
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
        for (id in ids) {
            jdbc.update(
                """
                WITH RECURSIVE subtree(id) AS (
                  SELECT id FROM drive_nodes WHERE id = :id AND deleted_at IS NULL
                  UNION ALL
                  SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
                  WHERE n.deleted_at IS NULL
                )
                UPDATE drive_nodes
                SET deleted_at = :now, delete_batch_id = :batch, updated_at = :now
                WHERE id IN (SELECT id FROM subtree)
                """.trimIndent(),
                mapOf("id" to id, "now" to now, "batch" to batch),
            )
        }
    }

    @Transactional
    fun restore(id: Long) {
        val n = findById(id)
        if (n.deletedAt == null) return
        if (n.deleteBatchId == null) {
            jdbc.update(
                "UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL WHERE id = :id",
                mapOf("id" to id),
            )
            return
        }

        val roots = jdbc.query(
            """
            SELECT * FROM drive_nodes n
            WHERE n.delete_batch_id = :batch
              AND (
                n.parent_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM drive_nodes p
                  WHERE p.id = n.parent_id AND p.delete_batch_id = n.delete_batch_id
                )
              )
            """.trimIndent(),
            mapOf("batch" to n.deleteBatchId),
            nodeMapper,
        )
        for (r in roots) {
            val hit = jdbc.queryForObject(
                """
                SELECT EXISTS(
                  SELECT 1 FROM drive_nodes
                  WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0)
                    AND LOWER(name) = LOWER(:name)
                    AND deleted_at IS NULL
                )
                """.trimIndent(),
                mapOf("pid" to r.parentId, "name" to r.name),
                Int::class.java,
            ) ?: 0
            if (hit == 1) throw ConflictException("name already exists in this folder")
        }
        jdbc.update(
            """
            UPDATE drive_nodes SET deleted_at = NULL, delete_batch_id = NULL
            WHERE delete_batch_id = :batch
            """.trimIndent(),
            mapOf("batch" to n.deleteBatchId),
        )
    }

    fun purge(ids: List<Long>) {
        for (id in ids) purgeOne(id)
    }

    @Transactional
    fun purgeOne(id: Long) {
        val rows = jdbc.query(
            """
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM drive_nodes WHERE id = :id
              UNION ALL
              SELECT n.id FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
            )
            SELECT n.id, n.blob_path FROM drive_nodes n WHERE n.id IN (SELECT id FROM subtree)
            """.trimIndent(),
            mapOf("id" to id),
        ) { rs, _ -> rs.getLong("id") to rs.getString("blob_path") }
        if (rows.isEmpty()) throw NotFoundException("drive node not found")

        // Delete the whole subtree explicitly (don't rely on FK cascade — test profile may have FK off).
        val ids = rows.map { it.first }
        jdbc.update(
            "DELETE FROM drive_nodes WHERE id IN (:ids)",
            mapOf("ids" to ids),
        )
        for ((_, blob) in rows) {
            if (blob.isNullOrBlank()) continue
            runCatching { File(blobAbsPath(blob)).delete() }
            driveThumbService.purgeThumb(blob)
        }
    }

    data class DescendantRow(
        val id: Long,
        val type: String,
        val name: String,
        val blobPath: String?,
        val relPath: String,
    )

    fun collectDescendants(rootId: Long): List<DescendantRow> {
        val sql = """
            WITH RECURSIVE subtree(id, type, name, blob_path, rel_path) AS (
              SELECT id, type, name, blob_path, name AS rel_path
              FROM drive_nodes WHERE id = :rid AND deleted_at IS NULL
              UNION ALL
              SELECT n.id, n.type, n.name, n.blob_path, s.rel_path || '/' || n.name
              FROM drive_nodes n JOIN subtree s ON n.parent_id = s.id
              WHERE n.deleted_at IS NULL
            )
            SELECT id, type, name, blob_path, rel_path FROM subtree
        """.trimIndent()
        return jdbc.query(sql, mapOf("rid" to rootId)) { rs, _ ->
            DescendantRow(
                rs.getLong("id"),
                rs.getString("type"),
                rs.getString("name"),
                rs.getString("blob_path"),
                rs.getString("rel_path"),
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
            jdbc.queryForObject(
                """
                INSERT INTO drive_nodes (parent_id, type, name, blob_path, size, hash, created_at, updated_at)
                VALUES (:pid, 'file', :name, :blob, :size, NULLIF(:hash, ''), :now, :now)
                RETURNING id
                """.trimIndent(),
                mapOf(
                    "pid" to parentId, "name" to name, "blob" to blobPath,
                    "size" to size, "hash" to (hash ?: ""), "now" to now,
                ),
                Long::class.java,
            )!!
        } catch (e: Exception) {
            throw mapUniqueOrRethrow(e)
        }
        return findById(id)
    }

    /** Replace an existing same-name file ("overwrite" collision strategy). */
    @Transactional
    fun replaceFileNode(parentId: Long?, name: String, blobPath: String, hash: String?, size: Long): DriveNode {
        validateName(name)
        val existing = findActiveSibling(parentId, name)
        val now = System.currentTimeMillis()

        if (existing == null || existing.type != "file") {
            return try {
                createFileNode(parentId, name, blobPath, hash, size)
            } catch (e: ConflictException) {
                throw e
            }
        }
        val oldBlob = existing.blobPath
        jdbc.update(
            """
            UPDATE drive_nodes
            SET blob_path = :blob, size = :size, hash = NULLIF(:hash, ''), updated_at = :now
            WHERE id = :id
            """.trimIndent(),
            mapOf(
                "blob" to blobPath, "size" to size, "hash" to (hash ?: ""),
                "now" to now, "id" to existing.id,
            ),
        )
        if (!oldBlob.isNullOrBlank() && oldBlob != blobPath) {
            runCatching { File(blobAbsPath(oldBlob)).delete() }
            driveThumbService.purgeThumb(oldBlob)
        }
        return findById(existing.id)
    }

    /** Generate a non-conflicting filename (e.g. "report.pdf" -> "report (1).pdf"). */
    fun autoRename(parentId: Long?, name: String): String {
        if (findActiveSibling(parentId, name) == null) return name
        val dot = name.lastIndexOf('.')
        val (stem, ext) = if (dot <= 0) name to "" else name.substring(0, dot) to name.substring(dot)

        val prefix = likeEscape(stem) + " (%"
        val suffix = "%)" + likeEscape(ext)

        val rows = jdbc.query(
            """
            SELECT name FROM drive_nodes
            WHERE COALESCE(parent_id, 0) = COALESCE(:pid, 0)
              AND deleted_at IS NULL
              AND name LIKE :pre ESCAPE '\'
              AND name LIKE :suf ESCAPE '\'
            """.trimIndent(),
            mapOf("pid" to parentId, "pre" to prefix, "suf" to suffix),
        ) { rs, _ -> rs.getString("name") }

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
            cur = cur.cause
        }
        return false
    }

    companion object {
        fun mapNode(rs: ResultSet): DriveNode = DriveNode(
            id = rs.getLong("id"),
            parentId = rs.getObject("parent_id")?.let { (it as Number).toLong() },
            type = rs.getString("type"),
            name = rs.getString("name"),
            blobPath = rs.getString("blob_path"),
            size = rs.getObject("size")?.let { (it as Number).toLong() },
            hash = rs.getString("hash"),
            deletedAt = rs.getObject("deleted_at")?.let { (it as Number).toLong() },
            deleteBatchId = rs.getString("delete_batch_id"),
            createdAt = rs.getLong("created_at"),
            updatedAt = rs.getLong("updated_at"),
        )

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
