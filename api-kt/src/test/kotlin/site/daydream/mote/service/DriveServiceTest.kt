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
}
