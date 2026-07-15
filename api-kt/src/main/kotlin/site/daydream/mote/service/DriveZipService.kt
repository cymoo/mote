package site.daydream.mote.service

import org.jooq.DSLContext
import org.springframework.stereotype.Service
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.NotFoundException
import site.daydream.mote.model.DriveNode
import java.io.File
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@Service
class DriveZipService(
    private val dsl: DSLContext,
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
                    copyBlobInto(zw, d.blobPath)
                }
                zw.closeEntry()
            }
        }
    }

    /**
     * Resolves a multi-select into zip targets: dedups ids, drops ids nested
     * under other selected ids (their content arrives via the ancestor) and
     * skips deleted/missing nodes. Throws NotFoundException when nothing
     * remains — callers resolve BEFORE streaming so a clean 404 is still
     * possible.
     */
    fun zipTargets(ids: List<Long>): List<DriveNode> {
        val uniq = ids.distinct()
        val nested = nestedSelections(uniq)
        val targets = uniq.asSequence()
            .filter { it !in nested }
            .mapNotNull { driveService.findByIdOrNull(it) }
            .filter { it.deletedAt == null }
            .toList()
        if (targets.isEmpty()) throw NotFoundException("drive node not found")
        return targets
    }

    /**
     * Streams a zip archive of the given nodes. Unlike zipFolder — which
     * strips the root folder's own name — selected folders appear as
     * top-level directories and selected files as top-level entries.
     * Same-named top-level entries get a "name (1)" suffix rather than being
     * silently dropped: a multi-select from search results can legitimately
     * pick same-named nodes from different folders.
     */
    fun zipResolvedNodes(targets: List<DriveNode>, out: OutputStream) {
        ZipOutputStream(out).use { zw ->
            val topLevel = HashSet<String>()
            for (root in targets) {
                if (root.type == "file") {
                    val name = uniqueTopLevel(topLevel, sanitizeZipPath(root.name))
                    if (name.isBlank() || root.blobPath.isNullOrBlank()) continue
                    zw.putNextEntry(ZipEntry(name))
                    copyBlobInto(zw, root.blobPath)
                    zw.closeEntry()
                    continue
                }

                val descendants = driveService.collectDescendants(root.id)
                val topName = uniqueTopLevel(topLevel, sanitizeZipPath(root.name))
                if (topName.isBlank()) continue
                val seen = HashSet<String>()
                for (d in descendants) {
                    val rel = if (d.id == root.id) {
                        topName
                    } else {
                        // relPath starts with the root's own name; swap it for
                        // the (possibly suffixed) reserved top-level name.
                        val sub = sanitizeZipPath(d.relPath.removePrefix(root.name).removePrefix("/"))
                        if (sub.isBlank()) continue
                        "$topName/$sub"
                    }
                    val name = if (d.type == "folder") "$rel/" else rel
                    if (!seen.add(name)) continue
                    zw.putNextEntry(ZipEntry(name))
                    if (d.type == "file" && !d.blobPath.isNullOrBlank()) {
                        copyBlobInto(zw, d.blobPath)
                    }
                    zw.closeEntry()
                }
            }
        }
    }

    fun zipNodes(ids: List<Long>, out: OutputStream) = zipResolvedNodes(zipTargets(ids), out)

    /**
     * Returns the subset of ids that are strict descendants of other ids in
     * the same selection (possible when multi-selecting from search results,
     * where ancestors and descendants can appear side by side).
     */
    private fun nestedSelections(ids: List<Long>): Set<Long> {
        if (ids.size < 2) return emptySet()
        val placeholders = ids.joinToString(",") { "?" }
        // Keep as raw SQL: recursive CTE + dynamic IN clause.
        return dsl.resultQuery(
            """
            WITH RECURSIVE descendants(id) AS (
              SELECT n.id FROM drive_nodes n WHERE n.parent_id IN ($placeholders)
              UNION ALL
              SELECT n.id FROM drive_nodes n JOIN descendants d ON n.parent_id = d.id
            )
            SELECT id FROM descendants WHERE id IN ($placeholders)
            """.trimIndent(),
            *(ids + ids).map { it as Any? }.toTypedArray(),
        ).fetch { it.get("id", Long::class.java) }.toSet()
    }

    /** Streams a stored blob into the zip; a missing blob file is skipped silently. */
    private fun copyBlobInto(zw: ZipOutputStream, blobPath: String) {
        val f = File(driveService.blobAbsPath(blobPath))
        if (f.exists()) f.inputStream().use { it.copyTo(zw) }
    }

    companion object {
        private fun sanitizeZipPath(p: String): String =
            p.split('/')
                .map { it.trim() }
                .filter { it.isNotEmpty() && it != "." && it != ".." }
                .joinToString("/")

        /** Reserves a unique top-level entry name, suffixing "stem (1).ext" on collision. */
        fun uniqueTopLevel(seen: MutableSet<String>, name: String): String {
            if (name.isBlank()) return ""
            var cand = name
            var i = 1
            while (!seen.add(cand)) {
                val dot = name.lastIndexOf('.')
                val (stem, ext) = if (dot <= 0) name to "" else name.substring(0, dot) to name.substring(dot)
                cand = "$stem ($i)$ext"
                i++
            }
            return cand
        }
    }
}
