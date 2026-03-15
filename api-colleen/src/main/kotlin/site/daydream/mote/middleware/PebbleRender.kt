package site.daydream.mote.middleware

import io.github.cymoo.colleen.Context
import io.github.cymoo.colleen.Middleware
import io.github.cymoo.colleen.Next
import io.pebbletemplates.pebble.PebbleEngine
import io.pebbletemplates.pebble.loader.ClasspathLoader
import io.pebbletemplates.pebble.loader.FileLoader
import java.io.File
import java.io.StringWriter

/**
 * Pebble template rendering middleware.
 * Adds a render() function to the Context via state.
 */
class PebbleRender(
    private val templateDir: String = "templates",
    private val cache: Boolean = true
) : Middleware {
    private val engine: PebbleEngine

    init {
        val loader = ClasspathLoader().apply {
            prefix = templateDir
        }

        engine = PebbleEngine.Builder()
            .loader(loader)
            .cacheActive(cache)
            .build()
    }

    override fun invoke(ctx: Context, next: Next) {
        ctx.setState("pebbleEngine", engine)
        next()
    }
}

/**
 * Render a Pebble template with the given data model.
 */
fun Context.render(templateName: String, model: Map<String, Any?>) {
    val engine = getState<PebbleEngine>("pebbleEngine")
    val template = engine.getTemplate(templateName)
    val writer = StringWriter()
    template.evaluate(writer, model)
    html(writer.toString())
}
