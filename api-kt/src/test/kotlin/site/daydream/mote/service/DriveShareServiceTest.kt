package site.daydream.mote.service

import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.test.context.ActiveProfiles
import site.daydream.mote.exception.AuthenticationException
import site.daydream.mote.exception.BadRequestException
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
    fun `cannot share folders or non-existent nodes`() {
        val folder = drive.createFolder(null, "d")
        assertThrows(BadRequestException::class.java) { shares.create(folder.id, null, null) }
        assertThrows(NotFoundException::class.java) { shares.create(99999, null, null) }
    }

    @Test
    fun `bad token does not resolve`() {
        assertThrows(NotFoundException::class.java) { shares.resolve("not-a-real-token") }
        assertThrows(NotFoundException::class.java) { shares.resolve("") }
    }
}
