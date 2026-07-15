package site.daydream.mote.service

import org.junit.jupiter.api.*
import org.junit.jupiter.api.Assertions.*
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate
import org.springframework.test.context.ActiveProfiles
import site.daydream.mote.exception.NotFoundException
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipInputStream

@SpringBootTest
@ActiveProfiles("test")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class DriveZipServiceTest(
    @Autowired private val drive: DriveService,
    @Autowired private val zips: DriveZipService,
    @Autowired private val jdbc: NamedParameterJdbcTemplate,
) {
    @AfterEach
    fun cleanup() {
        jdbc.update("DELETE FROM drive_nodes", emptyMap<String, Any>())
    }

    /** Creates a file node with a real blob on disk; returns the node id. */
    private fun mustFile(parentId: Long?, name: String, blobRel: String, body: ByteArray): Long {
        val f = File(drive.blobAbsPath(blobRel))
        f.parentFile.mkdirs()
        f.writeBytes(body)
        return drive.createFileNode(parentId, name, blobRel, null, body.size.toLong()).id
    }

    private fun readZip(zip: ByteArray): Map<String, String> {
        val out = HashMap<String, String>()
        ZipInputStream(ByteArrayInputStream(zip)).use { zin ->
            while (true) {
                val e = zin.nextEntry ?: break
                out[e.name] = zin.readBytes().toString(Charsets.UTF_8)
                zin.closeEntry()
            }
        }
        return out
    }

    private fun zipNodes(ids: List<Long>): Map<String, String> {
        val buf = ByteArrayOutputStream()
        zips.zipNodes(ids, buf)
        return readZip(buf.toByteArray())
    }

    @Test
    fun `mixed folder + file selection lands as top-level entries`() {
        val folder = drive.createFolder(null, "photos")
        mustFile(folder.id, "a.jpg", "drive/zip_a.bin", "aaa".toByteArray())
        val rootFile = mustFile(null, "notes.txt", "drive/zip_notes.bin", "nnn".toByteArray())

        val got = zipNodes(listOf(folder.id, rootFile))
        assertEquals(
            mapOf("photos/" to "", "photos/a.jpg" to "aaa", "notes.txt" to "nnn"),
            got,
        )
    }

    @Test
    fun `ids nested under other selected folders are skipped, not doubled`() {
        val outer = drive.createFolder(null, "outer")
        val inner = drive.createFolder(outer.id, "inner")
        val nestedFile = mustFile(inner.id, "deep.txt", "drive/zip_deep.bin", "ddd".toByteArray())

        val got = zipNodes(listOf(outer.id, inner.id, nestedFile))
        assertEquals(
            mapOf("outer/" to "", "outer/inner/" to "", "outer/inner/deep.txt" to "ddd"),
            got,
        )
    }

    @Test
    fun `same-named top-level picks get suffixed instead of dropped`() {
        val f1 = drive.createFolder(null, "one")
        val f2 = drive.createFolder(null, "two")
        val a = mustFile(f1.id, "dup.txt", "drive/zip_dup_a.bin", "first".toByteArray())
        val b = mustFile(f2.id, "dup.txt", "drive/zip_dup_b.bin", "second".toByteArray())

        val got = zipNodes(listOf(a, b))
        assertEquals("first", got["dup.txt"])
        assertEquals("second", got["dup (1).txt"])
    }

    @Test
    fun `an entirely deleted or missing selection resolves to 404 before streaming`() {
        val f = drive.createFolder(null, "gone")
        drive.softDelete(listOf(f.id))
        assertThrows(NotFoundException::class.java) { zips.zipTargets(listOf(f.id, 99999L)) }
    }
}
