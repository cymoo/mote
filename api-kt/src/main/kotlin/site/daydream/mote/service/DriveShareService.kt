package site.daydream.mote.service

import org.springframework.dao.support.DataAccessUtils
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.stereotype.Service
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.GoneException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveNode
import site.daydream.mote.model.DriveShare
import site.daydream.mote.model.ShareWithNode
import java.security.MessageDigest
import java.security.SecureRandom
import java.sql.ResultSet
import java.util.Base64

@Service
class DriveShareService(
    private val jdbc: NamedParameterJdbcTemplate,
    private val driveService: DriveService,
) {
    private val bcrypt = BCryptPasswordEncoder()

    fun create(nodeId: Long, password: String?, expiresAt: Long?): Pair<DriveShare, String> {
        val n = driveService.findById(nodeId)
        if (n.type != "file") throw BadRequestException("only files can be shared")
        if (n.deletedAt != null) throw NotFoundException("drive node not found")

        val token = newToken(32)
        val hash = sha256Hex(token)
        val prefix = hash.substring(0, 8)
        val pwHash = if (!password.isNullOrEmpty()) bcrypt.encode(password) else null
        val exp = if (expiresAt != null && expiresAt > 0) expiresAt else null
        val now = System.currentTimeMillis()

        val id = jdbc.queryForObject(
            """
            INSERT INTO drive_shares (node_id, token_hash, token_prefix, password_hash, expires_at, created_at)
            VALUES (:nid, :h, :p, :pw, :exp, :now) RETURNING id
            """.trimIndent(),
            mapOf(
                "nid" to nodeId, "h" to hash, "p" to prefix,
                "pw" to pwHash, "exp" to exp, "now" to now,
            ),
            Long::class.java,
        )!!
        return findById(id) to token
    }

    fun findById(id: Long): DriveShare = DataAccessUtils.singleResult(
        jdbc.query("SELECT * FROM drive_shares WHERE id = :id", mapOf("id" to id), ::mapShare)
    ) ?: throw NotFoundException("share not found")

    fun listByNode(nodeId: Long): List<DriveShare> = jdbc.query(
        "SELECT * FROM drive_shares WHERE node_id = :nid ORDER BY created_at DESC",
        mapOf("nid" to nodeId), ::mapShare,
    )

    fun revoke(id: Long) {
        val n = jdbc.update("DELETE FROM drive_shares WHERE id = :id", mapOf("id" to id))
        if (n == 0) throw NotFoundException("share not found")
    }

    /** Resolves a plaintext token to (share, node). Caller must call verifyPassword separately. */
    fun resolve(token: String): Pair<DriveShare, DriveNode> {
        if (token.isEmpty()) throw NotFoundException("share not found")
        val hash = sha256Hex(token)
        val prefix = hash.substring(0, 8)

        val candidates = jdbc.query(
            "SELECT * FROM drive_shares WHERE token_prefix = :p", mapOf("p" to prefix), ::mapShare,
        )
        val match = candidates.firstOrNull { constantTimeEquals(it.tokenHash, hash) }
            ?: throw NotFoundException("share not found")

        if (match.expiresAt != null && match.expiresAt < System.currentTimeMillis()) {
            throw GoneException("share expired")
        }
        val node = driveService.findById(match.nodeId)
        if (node.deletedAt != null || node.type != "file") throw NotFoundException("share not found")
        return match to node
    }

    fun verifyPassword(share: DriveShare, password: String) {
        if (share.passwordHash.isNullOrEmpty()) throw BadRequestException("share has no password")
        if (!bcrypt.matches(password, share.passwordHash)) {
            throw AuthenticationException("wrong share password")
        }
    }

    fun listAll(includeExpired: Boolean): List<ShareWithNode> {
        val now = System.currentTimeMillis()
        val sql = buildString {
            append(
                """
                SELECT s.*, n.name AS n_name, COALESCE(n.size, 0) AS n_size, n.parent_id AS n_parent_id
                FROM drive_shares s
                JOIN drive_nodes n ON n.id = s.node_id
                WHERE n.deleted_at IS NULL
                """.trimIndent(),
            )
            if (!includeExpired) append(" AND (s.expires_at IS NULL OR s.expires_at > :now)")
            append(" ORDER BY s.created_at DESC")
        }
        val params = if (includeExpired) emptyMap<String, Any>() else mapOf("now" to now)
        data class Row(
            val share: DriveShare,
            val name: String,
            val size: Long,
            val parentId: Long?,
        )
        val rows = jdbc.query(sql, params) { rs, _ ->
            Row(
                share = mapShare(rs, 0),
                name = rs.getString("n_name"),
                size = rs.getLong("n_size"),
                parentId = rs.getObject("n_parent_id")?.let { (it as Number).toLong() },
            )
        }
        val pathCache = HashMap<Long, String>()
        return rows.map { r ->
            val path = if (r.parentId == null) "" else pathCache.getOrPut(r.parentId) {
                driveService.breadcrumbs(r.parentId).joinToString("/") { it.name }
            }
            ShareWithNode(r.share, r.name, r.size, r.parentId, path)
        }
    }

    fun purgeExpired(): Int = jdbc.update(
        "DELETE FROM drive_shares WHERE expires_at IS NOT NULL AND expires_at <= :now",
        mapOf("now" to System.currentTimeMillis()),
    )

    // ---------- helpers ----------

    private fun mapShare(rs: ResultSet, @Suppress("UNUSED_PARAMETER") rowNum: Int): DriveShare =
        DriveShare(
            id = rs.getLong("id"),
            nodeId = rs.getLong("node_id"),
            tokenHash = rs.getString("token_hash"),
            tokenPrefix = rs.getString("token_prefix"),
            passwordHash = rs.getString("password_hash"),
            expiresAt = rs.getObject("expires_at")?.let { (it as Number).toLong() },
            createdAt = rs.getLong("created_at"),
        )

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }

    companion object {
        private val RAND = SecureRandom()

        fun newToken(nBytes: Int): String {
            val b = ByteArray(nBytes)
            RAND.nextBytes(b)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
        }

        fun sha256Hex(s: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            val out = md.digest(s.toByteArray(Charsets.UTF_8))
            val sb = StringBuilder(out.size * 2)
            for (b in out) sb.append("%02x".format(b.toInt() and 0xff))
            return sb.toString()
        }
    }
}
