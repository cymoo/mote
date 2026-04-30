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
import site.daydream.mote.model.DriveUploadInitRequest
import java.io.ByteArrayInputStream

@SpringBootTest
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class DriveUploadServiceTest(
    @Autowired private val drive: DriveService,
    @Autowired private val uploads: DriveUploadService,
    @Autowired private val jdbc: NamedParameterJdbcTemplate,
) {
    @AfterEach
    fun cleanup() {
        jdbc.update("DELETE FROM drive_uploads", emptyMap<String, Any>())
        jdbc.update("DELETE FROM drive_nodes", emptyMap<String, Any>())
    }

    private val chunk = 1L shl 20 // 1 MiB

    private fun smallInit(name: String = "x.txt", size: Long = 5L) =
        uploads.init(DriveUploadInitRequest(parentId = null, name = name, size = size, chunkSize = chunk))

    @Test
    fun `init validates name and size`() {
        assertThrows(BadRequestException::class.java) {
            uploads.init(DriveUploadInitRequest(null, "bad/name", 1, chunk))
        }
        assertThrows(BadRequestException::class.java) {
            uploads.init(DriveUploadInitRequest(null, "ok.txt", 0, chunk))
        }
        assertThrows(BadRequestException::class.java) {
            uploads.init(DriveUploadInitRequest(null, "ok.txt", 1, 1L)) // chunk too small
        }
    }

    @Test
    fun `single chunk upload completes successfully`() {
        val u = smallInit("hello.txt", 5)
        uploads.putChunk(u.id, 0, ByteArrayInputStream("hello".toByteArray()))
        val node = uploads.complete(u.id, "ask")
        assertEquals("hello.txt", node.name)
        assertEquals(5L, node.size)
    }

    @Test
    fun `chunk index out of range fails`() {
        val u = smallInit()
        assertThrows(BadRequestException::class.java) {
            uploads.putChunk(u.id, 99, ByteArrayInputStream("hi".toByteArray()))
        }
    }

    @Test
    fun `complete before all chunks received fails`() {
        val u = smallInit("two.txt", 5)
        // Don't write the chunk
        assertThrows(BadRequestException::class.java) { uploads.complete(u.id, "ask") }
    }

    @Test
    fun `cancel deletes upload and chunks`() {
        val u = smallInit()
        uploads.cancel(u.id)
        assertThrows(NotFoundException::class.java) { uploads.get(u.id) }
    }

    @Test
    fun `on_collision policies`() {
        // Pre-create file
        drive.createFileNode(null, "dup.txt", "drive/x_dup.txt", null, 1)

        // skip → returns existing node, no new file
        run {
            val u = smallInit("dup.txt", 5)
            uploads.putChunk(u.id, 0, ByteArrayInputStream("hello".toByteArray()))
            val n = uploads.complete(u.id, "skip")
            assertEquals("dup.txt", n.name)
        }

        // ask → conflict
        run {
            val u = smallInit("dup.txt", 5)
            uploads.putChunk(u.id, 0, ByteArrayInputStream("hello".toByteArray()))
            assertThrows(ConflictException::class.java) { uploads.complete(u.id, "ask") }
        }

        // rename → new file with different name
        run {
            val u = smallInit("dup.txt", 5)
            uploads.putChunk(u.id, 0, ByteArrayInputStream("hello".toByteArray()))
            val n = uploads.complete(u.id, "rename")
            assertNotEquals("dup.txt", n.name)
        }
    }

    @Test
    fun `init under deleted parent fails`() {
        val f = drive.createFolder(null, "p")
        drive.softDelete(listOf(f.id))
        assertThrows(NotFoundException::class.java) {
            uploads.init(DriveUploadInitRequest(f.id, "x.txt", 5, chunk))
        }
    }
}
