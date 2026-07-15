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
import site.daydream.mote.model.DriveNode
import site.daydream.mote.model.DriveUploadInitRequest
import java.io.ByteArrayInputStream
import java.io.File

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

    /** init → single chunk → complete (content must fit into one chunk). */
    private fun performUpload(name: String, content: ByteArray, onCollision: String = "ask"): DriveNode {
        val u = uploads.init(
            DriveUploadInitRequest(parentId = null, name = name, size = content.size.toLong(), chunkSize = chunk),
        )
        uploads.putChunk(u.id, 0, ByteArrayInputStream(content))
        return uploads.complete(u.id, onCollision)
    }

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

    @Test
    fun `dedup reuses an existing blob with identical content`() {
        val body = "identical bytes".toByteArray()
        val driveDir = File(drive.blobAbsPath("drive"))
        val before = driveDir.listFiles()?.count { it.isFile } ?: 0

        val n1 = performUpload("one.txt", body)
        val n2 = performUpload("two.txt", body)

        assertEquals(n1.blobPath, n2.blobPath, "expected shared blob")
        val after = driveDir.listFiles()?.count { it.isFile } ?: 0
        assertEquals(before + 1, after, "expected exactly one new blob file")
    }

    @Test
    fun `dedup skips a candidate whose blob is missing on disk`() {
        val body = "payload to lose".toByteArray()
        val n1 = performUpload("one.txt", body)
        // Simulate external deletion of the stored blob.
        assertTrue(File(drive.blobAbsPath(n1.blobPath!!)).delete())

        val n2 = performUpload("two.txt", body)
        assertNotEquals(n1.blobPath, n2.blobPath, "must not reuse a missing blob")
        assertTrue(File(drive.blobAbsPath(n2.blobPath!!)).exists(), "fresh blob missing")
    }

    @Test
    fun `dedup on overwrite with identical content keeps the blob`() {
        val body = "same content twice".toByteArray()
        val n1 = performUpload("dup2.txt", body)
        val n2 = performUpload("dup2.txt", body, "overwrite")

        assertEquals(n1.blobPath, n2.blobPath, "overwrite should reuse the identical blob")
        assertArrayEquals(body, File(drive.blobAbsPath(n2.blobPath!!)).readBytes(), "blob gone after self-overwrite")
    }
}
