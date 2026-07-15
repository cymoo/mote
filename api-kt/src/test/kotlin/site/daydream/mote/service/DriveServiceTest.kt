package site.daydream.mote.service

import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.test.context.ActiveProfiles
import site.daydream.mote.exception.BadRequestException
import site.daydream.mote.exception.ConflictException
import site.daydream.mote.exception.NotFoundException
import java.io.File

@SpringBootTest
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class DriveServiceTest(
    @Autowired private val drive: DriveService,
    @Autowired private val jdbc: NamedParameterJdbcTemplate,
) {
    @AfterEach
    fun cleanup() {
        jdbc.update("DELETE FROM drive_shares", emptyMap<String, Any>())
        jdbc.update("DELETE FROM drive_uploads", emptyMap<String, Any>())
        jdbc.update("DELETE FROM drive_nodes", emptyMap<String, Any>())
    }

    /** Writes a real blob file under the upload dir so purge/replace can act on it. */
    private fun writeBlob(rel: String, content: ByteArray): File {
        val f = File(drive.blobAbsPath(rel))
        f.parentFile.mkdirs()
        f.writeBytes(content)
        return f
    }

    @Test
    fun `create folder + rename + duplicate name conflict`() {
        val a = drive.createFolder(null, "alpha")
        assertEquals("alpha", a.name)
        assertEquals("folder", a.type)

        // duplicate name in same parent → 409
        assertThrows(ConflictException::class.java) { drive.createFolder(null, "alpha") }

        // rename
        drive.rename(a.id, "beta")
        assertEquals("beta", drive.findById(a.id).name)

        // rename to existing sibling → 409
        drive.createFolder(null, "gamma")
        assertThrows(ConflictException::class.java) { drive.rename(a.id, "gamma") }

        // invalid name
        assertThrows(BadRequestException::class.java) { drive.createFolder(null, "a/b") }
        assertThrows(BadRequestException::class.java) { drive.createFolder(null, "..") }
    }

    @Test
    fun `move with cycle detection and conflict`() {
        val a = drive.createFolder(null, "a")
        val b = drive.createFolder(a.id, "b")
        val c = drive.createFolder(b.id, "c")

        // moving a into c (its descendant) must fail
        assertThrows(BadRequestException::class.java) { drive.move(listOf(a.id), c.id) }

        // move c to root succeeds
        drive.move(listOf(c.id), null)
        assertNull(drive.findById(c.id).parentId)

        // sibling collision in target parent
        drive.createFolder(null, "x")
        val x2 = drive.createFolder(a.id, "x")
        assertThrows(ConflictException::class.java) { drive.move(listOf(x2.id), null) }
    }

    @Test
    fun `soft delete then restore with sibling collision`() {
        val a = drive.createFolder(null, "f1")
        drive.softDelete(listOf(a.id))
        // listing root no longer includes it
        assertTrue(drive.list(null, null, null, null).none { it.id == a.id })
        // appears in trash
        assertTrue(drive.listTrash().any { it.id == a.id })

        // create new sibling with same name
        drive.createFolder(null, "f1")
        // restore must fail → conflict
        assertThrows(ConflictException::class.java) { drive.restore(a.id) }
    }

    @Test
    fun `breadcrumbs returns chain root-to-node`() {
        val a = drive.createFolder(null, "a")
        val b = drive.createFolder(a.id, "b")
        val c = drive.createFolder(b.id, "c")
        val crumbs = drive.breadcrumbs(c.id)
        assertEquals(listOf("a", "b", "c"), crumbs.map { it.name })
    }

    @Test
    fun `auto rename appends suffix on collision`() {
        drive.createFolder(null, "doc.txt")
        val n1 = drive.autoRename(null, "doc.txt")
        assertNotEquals("doc.txt", n1)
        assertTrue(n1.startsWith("doc") && n1.endsWith(".txt"))
    }

    @Test
    fun `validate name rejects bad inputs`() {
        assertThrows(BadRequestException::class.java) { DriveService.validateName("") }
        assertThrows(BadRequestException::class.java) { DriveService.validateName(".") }
        assertThrows(BadRequestException::class.java) { DriveService.validateName("..") }
        assertThrows(BadRequestException::class.java) { DriveService.validateName("a/b") }
        assertThrows(BadRequestException::class.java) { DriveService.validateName("a\\b") }
        DriveService.validateName("ok name.txt")
    }

    @Test
    fun `findById on missing throws 404`() {
        assertThrows(NotFoundException::class.java) { drive.findById(99999) }
    }

    @Test
    fun `purge keeps a blob shared by another row and removes the last orphan`() {
        val blob = "drive/x_shared_purge.txt"
        val abs = writeBlob(blob, "shared".toByteArray())

        val a = drive.createFileNode(null, "a.txt", blob, "h", 6)
        val b = drive.createFileNode(null, "b.txt", blob, "h", 6)

        drive.purge(listOf(a.id))
        assertTrue(abs.exists(), "blob removed while still referenced")

        drive.purge(listOf(b.id))
        assertFalse(abs.exists(), "blob should be gone after last reference purged")
    }

    @Test
    fun `replace keeps a blob shared by another row and removes the last orphan`() {
        val oldBlob = "drive/x_replace_old.txt"
        val oldAbs = writeBlob(oldBlob, "old".toByteArray())
        val newBlob = "drive/x_replace_new.txt"
        writeBlob(newBlob, "new".toByteArray())

        drive.createFileNode(null, "a.txt", oldBlob, "h", 3)
        drive.createFileNode(null, "b.txt", oldBlob, "h", 3)

        // Overwrite a.txt with the new blob; the old blob is still used by b.txt.
        drive.replaceFileNode(null, "a.txt", newBlob, "h2", 3)
        assertTrue(oldAbs.exists(), "shared old blob removed")

        // Overwrite b.txt too — the old blob is now orphaned and must go.
        drive.replaceFileNode(null, "b.txt", newBlob, "h2", 3)
        assertFalse(oldAbs.exists(), "orphaned old blob should be removed")
    }

    @Test
    fun `purgeTrashOlderThan removes old trash and refcounts blobs`() {
        val sharedBlob = "drive/x_trash_shared.txt"
        val sharedAbs = writeBlob(sharedBlob, "s".toByteArray())
        val soleBlob = "drive/x_trash_sole.txt"
        val soleAbs = writeBlob(soleBlob, "o".toByteArray())

        val keeper = drive.createFileNode(null, "keeper.txt", sharedBlob, "hs", 1)
        val trashedShared = drive.createFileNode(null, "trashed-shared.txt", sharedBlob, "hs", 1)
        val trashedSole = drive.createFileNode(null, "trashed-sole.txt", soleBlob, "ho", 1)
        val fresh = drive.createFileNode(null, "fresh.txt", "drive/x_trash_fresh.txt", "hf", 1)
        drive.softDelete(listOf(trashedShared.id, trashedSole.id))
        drive.softDelete(listOf(fresh.id))

        // Backdate the first batch past the cutoff; `fresh` stays recent.
        val old = System.currentTimeMillis() - 31L * 24 * 60 * 60 * 1000
        jdbc.update(
            "UPDATE drive_nodes SET deleted_at = :d WHERE id IN (:ids)",
            mapOf("d" to old, "ids" to listOf(trashedShared.id, trashedSole.id)),
        )

        val purged = drive.purgeTrashOlderThan(System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000)
        assertEquals(2, purged)
        assertThrows(NotFoundException::class.java) { drive.findById(trashedSole.id) }
        assertNotNull(drive.findById(keeper.id))
        assertNotNull(drive.findById(fresh.id))
        assertTrue(sharedAbs.exists(), "blob still referenced by an active row")
        assertFalse(soleAbs.exists(), "orphaned blob should be removed")
    }

    @Test
    fun `copying a file shares the blob and strips stars + shares`() {
        val dest = drive.createFolder(null, "dest")
        writeBlob("drive/x_copy_src.txt", "x".toByteArray())
        val src = drive.createFileNode(null, "src.txt", "drive/x_copy_src.txt", "h", 1)
        drive.setStarred(listOf(src.id), true)
        jdbc.update(
            "INSERT INTO drive_shares (node_id, token_hash, token_prefix, expires_at, created_at) VALUES (:nid, 'tk', 'tk', NULL, 1)",
            mapOf("nid" to src.id),
        )

        val out = drive.copy(listOf(src.id), dest.id)
        assertEquals(1, out.size)
        val cp = out[0]
        assertNotEquals(src.id, cp.id, "copy must be a fresh row")
        assertEquals("drive/x_copy_src.txt", cp.blobPath, "copy should share the blob")
        assertNull(cp.starredAt, "copy must not inherit the star")
        val shares = jdbc.queryForObject(
            "SELECT COUNT(*) FROM drive_shares WHERE node_id = :id",
            mapOf("id" to cp.id),
            Int::class.java,
        )
        assertEquals(0, shares, "copy must not inherit shares")
    }

    @Test
    fun `copying a folder replicates the whole subtree with an auto-renamed root`() {
        val a = drive.createFolder(null, "a")
        val b = drive.createFolder(a.id, "b")
        writeBlob("drive/x_copy_c.txt", "c".toByteArray())
        drive.createFileNode(b.id, "c.txt", "drive/x_copy_c.txt", "h", 1)
        drive.createFileNode(a.id, "d.txt", "drive/x_copy_c.txt", "h", 1)

        // Copy a → root: name "a" is taken by the source itself → "a (1)".
        val out = drive.copy(listOf(a.id), null)
        val root = out[0]
        assertEquals("a (1)", root.name)

        val l1 = drive.list(root.id, null, "name", "asc")
        assertEquals(listOf("b", "d.txt"), l1.map { it.name })
        val l2 = drive.list(l1[0].id, null, "name", "asc")
        assertEquals(1, l2.size)
        assertEquals("c.txt", l2[0].name)
        assertEquals("drive/x_copy_c.txt", l2[0].blobPath)
    }

    @Test
    fun `copying a folder into itself or its own descendant is rejected`() {
        val a = drive.createFolder(null, "a")
        val b = drive.createFolder(a.id, "b")

        assertThrows(BadRequestException::class.java) { drive.copy(listOf(a.id), b.id) }
        assertThrows(BadRequestException::class.java) { drive.copy(listOf(a.id), a.id) }
    }

    @Test
    fun `duplicate-in-place twice yields (1) then (2)`() {
        val parent = drive.createFolder(null, "p")
        writeBlob("drive/x_dup_twice.txt", "x".toByteArray())
        val src = drive.createFileNode(parent.id, "x.txt", "drive/x_dup_twice.txt", "h", 1)

        val c1 = drive.copy(listOf(src.id), parent.id)
        val c2 = drive.copy(listOf(src.id), parent.id)
        assertEquals("x (1).txt", c1[0].name)
        assertEquals("x (2).txt", c2[0].name)
    }

    @Test
    fun `star unstar and starred listing`() {
        val folder = drive.createFolder(null, "f")
        writeBlob("drive/x_star.txt", "s".toByteArray())
        val file = drive.createFileNode(folder.id, "s.txt", "drive/x_star.txt", "h", 1)

        drive.setStarred(listOf(folder.id, file.id), true)
        var out = drive.listStarred()
        assertEquals(2, out.size)
        assertEquals("f", out.first { it.id == file.id }.path, "starred file should carry its ancestor path")

        // Starring must not bump updated_at.
        assertEquals(file.updatedAt, drive.findById(file.id).updatedAt)

        // Trashed items disappear from the listing but keep their star.
        drive.softDelete(listOf(file.id))
        out = drive.listStarred()
        assertEquals(listOf(folder.id), out.map { it.id })
        drive.restore(file.id)
        assertEquals(2, drive.listStarred().size)

        // Unstar both.
        drive.setStarred(listOf(folder.id, file.id), false)
        assertTrue(drive.listStarred().isEmpty())
    }

    @Test
    fun `ensureFolderPath creates, reuses and validates segments`() {
        val leaf = drive.ensureFolderPath(null, "a/b/c")
        assertEquals("folder", leaf.type)
        assertEquals("c", leaf.name)
        val bc = drive.breadcrumbs(leaf.id)
        assertEquals(listOf("a", "b", "c"), bc.map { it.name })

        // Idempotent: the second call returns the same folder.
        assertEquals(leaf.id, drive.ensureFolderPath(null, "a/b/c").id)

        // Case-insensitive reuse of existing segments.
        assertEquals(bc[1].id, drive.ensureFolderPath(null, "A/B").id)

        // A file blocking the path → conflict, not auto-rename.
        writeBlob("drive/x_block.txt", "x".toByteArray())
        drive.createFileNode(null, "block.txt", "drive/x_block.txt", null, 1)
        assertThrows(ConflictException::class.java) { drive.ensureFolderPath(null, "block.txt/sub") }

        // Invalid segments rejected.
        assertThrows(BadRequestException::class.java) { drive.ensureFolderPath(null, "../evil") }
        assertThrows(BadRequestException::class.java) { drive.ensureFolderPath(null, "///") }
    }

    @Test
    fun `share counts include folders`() {
        val folder = drive.createFolder(null, "shared-folder")
        jdbc.update(
            "INSERT INTO drive_shares (node_id, token_hash, token_prefix, expires_at, created_at) VALUES (:nid, 'fh', 'fh', NULL, 1)",
            mapOf("nid" to folder.id),
        )

        val out = drive.list(null, null, null, null)
        assertEquals(1, out.size)
        assertEquals(1, out[0].shareCount)
    }

    @Test
    fun `usage counts logical bytes per row and each distinct blob once`() {
        writeBlob("drive/x_usage_x.bin", "xxxxx".toByteArray())
        writeBlob("drive/x_usage_y.bin", "yyyyyyy".toByteArray())

        val f1 = drive.createFileNode(null, "one.bin", "drive/x_usage_x.bin", "hx", 5)
        drive.copy(listOf(f1.id), null) // shares the x blob
        val f3 = drive.createFileNode(null, "three.bin", "drive/x_usage_y.bin", "hy", 7)
        drive.softDelete(listOf(f3.id))

        val u = drive.usage()
        assertEquals(10, u.activeBytes)
        assertEquals(2, u.activeCount)
        assertEquals(7, u.trashBytes)
        assertEquals(1, u.trashCount)
        assertEquals(12, u.physicalBytes)
    }
}
