package site.daydream.mote.service

import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.test.context.ActiveProfiles
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.GoneException
import site.daydream.mote.exception.NotFoundException

@SpringBootTest
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class DriveShareServiceTest(
    @Autowired private val drive: DriveService,
    @Autowired private val shares: DriveShareService,
    @Autowired private val jdbc: NamedParameterJdbcTemplate,
) {
    @AfterEach
    fun cleanup() {
        jdbc.update("DELETE FROM drive_shares", emptyMap<String, Any>())
        jdbc.update("DELETE FROM drive_nodes", emptyMap<String, Any>())
    }

    private fun newFile(name: String = "f.txt"): Long =
        drive.createFileNode(null, name, "drive/x_$name", null, 10).id

    @Test
    fun `create resolve revoke`() {
        val nid = newFile()
        val (share, token) = shares.create(nid, null, null)
        val (resolved, node) = shares.resolve(token)
        assertEquals(share.id, resolved.id)
        assertEquals(nid, node.id)

        shares.revoke(share.id)
        assertThrows(NotFoundException::class.java) { shares.resolve(token) }
    }

    @Test
    fun `password enforcement`() {
        val nid = newFile()
        val (share, _) = shares.create(nid, "secret", null)
        assertThrows(AuthenticationException::class.java) { shares.verifyPassword(share, "wrong") }
        shares.verifyPassword(share, "secret") // no throw
    }

    @Test
    fun `expired share returns 410`() {
        val nid = newFile()
        val (_, token) = shares.create(nid, null, System.currentTimeMillis() - 1000)
        assertThrows(GoneException::class.java) { shares.resolve(token) }
    }

    @Test
    fun `folder shares create and resolve`() {
        val folder = drive.createFolder(null, "Pics")
        val (_, token) = shares.create(folder.id, null, null)
        val (_, node) = shares.resolve(token)
        assertEquals(folder.id, node.id)
        assertEquals("folder", node.type)
    }

    @Test
    fun `cannot share non-existent or deleted nodes`() {
        assertThrows(NotFoundException::class.java) { shares.create(99999, null, null) }
        val gone = drive.createFolder(null, "gone")
        drive.softDelete(listOf(gone.id))
        assertThrows(NotFoundException::class.java) { shares.create(gone.id, null, null) }
    }

    @Test
    fun `resolveChild scopes ids to active descendants of the share root`() {
        val root = drive.createFolder(null, "root")
        val sub = drive.createFolder(root.id, "sub")
        val inner = drive.createFileNode(sub.id, "in.txt", "drive/x_in.txt", null, 2)
        val outside = drive.createFileNode(null, "out.txt", "drive/x_out.txt", null, 3)

        // The root itself resolves.
        assertEquals(root.id, shares.resolveChild(root.id, root.id).id)
        // An active descendant resolves.
        assertEquals(inner.id, shares.resolveChild(root.id, inner.id).id)
        // A node outside the share subtree → not found.
        assertThrows(NotFoundException::class.java) { shares.resolveChild(root.id, outside.id) }

        // A trashed descendant → not found.
        drive.softDelete(listOf(inner.id))
        assertThrows(NotFoundException::class.java) { shares.resolveChild(root.id, inner.id) }

        // A child inside a trashed folder → not found (the deleted hop breaks the chain).
        val f2 = drive.createFolder(root.id, "f2")
        val leaf = drive.createFileNode(f2.id, "leaf.txt", "drive/x_leaf.txt", null, 4)
        drive.softDelete(listOf(f2.id))
        assertThrows(NotFoundException::class.java) { shares.resolveChild(root.id, leaf.id) }
    }

    @Test
    fun `bad token does not resolve`() {
        assertThrows(NotFoundException::class.java) { shares.resolve("not-a-real-token") }
        assertThrows(NotFoundException::class.java) { shares.resolve("") }
    }
}
