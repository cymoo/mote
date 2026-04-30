package site.daydream.mote.service

import org.jooq.DSLContext
import org.jooq.Record
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.stereotype.Service
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.GoneException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.generated.Tables.DRIVE_SHARES
import site.daydream.mote.model.DriveNode
import site.daydream.mote.model.DriveShare
import site.daydream.mote.model.ShareWithNode
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

@Service
class DriveShareService(
    private val dsl: DSLContext,
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

        val id = dsl.insertInto(DRIVE_SHARES)
            .set(DRIVE_SHARES.NODE_ID, nodeId)
            .set(DRIVE_SHARES.TOKEN_HASH, hash)
            .set(DRIVE_SHARES.TOKEN_PREFIX, prefix)
            .set(DRIVE_SHARES.PASSWORD_HASH, pwHash)
            .set(DRIVE_SHARES.EXPIRES_AT, exp)
            .set(DRIVE_SHARES.CREATED_AT, now)
            .returningResult(DRIVE_SHARES.ID)
            .fetchOne()!!.value1()
        return findById(id) to token
    }

    fun findById(id: Long): DriveShare =
        dsl.selectFrom(DRIVE_SHARES).where(DRIVE_SHARES.ID.eq(id)).fetchOne()
            ?.let { mapShareRecord(it) }
            ?: throw NotFoundException("share not found")

    fun listByNode(nodeId: Long): List<DriveShare> =
        dsl.selectFrom(DRIVE_SHARES)
            .where(DRIVE_SHARES.NODE_ID.eq(nodeId))
            .orderBy(DRIVE_SHARES.CREATED_AT.desc())
            .fetch { mapShareRecord(it) }

    fun revoke(id: Long) {
        val n = dsl.deleteFrom(DRIVE_SHARES).where(DRIVE_SHARES.ID.eq(id)).execute()
        if (n == 0) throw NotFoundException("share not found")
    }

    /** Resolves a plaintext token to (share, node). Caller must call verifyPassword separately. */
    fun resolve(token: String): Pair<DriveShare, DriveNode> {
        if (token.isEmpty()) throw NotFoundException("share not found")
        val hash = sha256Hex(token)
        val prefix = hash.substring(0, 8)

        val candidates = dsl.selectFrom(DRIVE_SHARES)
            .where(DRIVE_SHARES.TOKEN_PREFIX.eq(prefix))
            .fetch { mapShareRecord(it) }
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
        // Keep as raw SQL because of the JOIN across two tables with aliased columns.
        val sql = buildString {
            append(
                """
                SELECT s.*, n.name AS n_name, COALESCE(n.size, 0) AS n_size, n.parent_id AS n_parent_id
                FROM drive_shares s
                JOIN drive_nodes n ON n.id = s.node_id
                WHERE n.deleted_at IS NULL
                """.trimIndent(),
            )
            if (!includeExpired) append(" AND (s.expires_at IS NULL OR s.expires_at > ?)")
            append(" ORDER BY s.created_at DESC")
        }
        data class Row(
            val share: DriveShare,
            val name: String,
            val size: Long,
            val parentId: Long?,
        )
        val rows = if (includeExpired) {
            dsl.resultQuery(sql).fetch { rec ->
                Row(
                    share = mapShareFromRawRecord(rec),
                    name = rec.get("n_name", String::class.java),
                    size = rec.get("n_size", Long::class.java),
                    parentId = rec.get("n_parent_id", Long::class.javaObjectType),
                )
            }
        } else {
            dsl.resultQuery(sql, now).fetch { rec ->
                Row(
                    share = mapShareFromRawRecord(rec),
                    name = rec.get("n_name", String::class.java),
                    size = rec.get("n_size", Long::class.java),
                    parentId = rec.get("n_parent_id", Long::class.javaObjectType),
                )
            }
        }
        val pathCache = HashMap<Long, String>()
        return rows.map { r ->
            val path = if (r.parentId == null) "" else pathCache.getOrPut(r.parentId) {
                driveService.breadcrumbs(r.parentId).joinToString("/") { it.name }
            }
            ShareWithNode(r.share, r.name, r.size, r.parentId, path)
        }
    }

    fun purgeExpired(): Int = dsl.deleteFrom(DRIVE_SHARES)
        .where(DRIVE_SHARES.EXPIRES_AT.isNotNull)
        .and(DRIVE_SHARES.EXPIRES_AT.lessOrEqual(System.currentTimeMillis()))
        .execute()

    // ---------- helpers ----------

    private fun mapShareRecord(rec: Record): DriveShare = DriveShare(
        id = rec.get(DRIVE_SHARES.ID)!!,
        nodeId = rec.get(DRIVE_SHARES.NODE_ID)!!,
        tokenHash = rec.get(DRIVE_SHARES.TOKEN_HASH)!!,
        tokenPrefix = rec.get(DRIVE_SHARES.TOKEN_PREFIX)!!,
        passwordHash = rec.get(DRIVE_SHARES.PASSWORD_HASH),
        expiresAt = rec.get(DRIVE_SHARES.EXPIRES_AT),
        createdAt = rec.get(DRIVE_SHARES.CREATED_AT)!!,
    )

    /** Maps a record from a raw JOIN query where share columns are not aliased. */
    private fun mapShareFromRawRecord(rec: Record): DriveShare = DriveShare(
        id = rec.get("id", Long::class.java),
        nodeId = rec.get("node_id", Long::class.java),
        tokenHash = rec.get("token_hash", String::class.java),
        tokenPrefix = rec.get("token_prefix", String::class.java),
        passwordHash = rec.get("password_hash", String::class.java),
        expiresAt = rec.get("expires_at", Long::class.javaObjectType),
        createdAt = rec.get("created_at", Long::class.java),
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
