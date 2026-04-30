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
}
