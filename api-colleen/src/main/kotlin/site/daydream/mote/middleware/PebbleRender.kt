package site.daydream.mote.middleware

import io.github.cymoo.colleen.Context
import io.github.cymoo.colleen.Middleware
import io.github.cymoo.colleen.Next
import io.pebbletemplates.pebble.PebbleEngine
import io.pebbletemplates.pebble.extension.Extension
import io.pebbletemplates.pebble.extension.ExtensionCustomizer
import io.pebbletemplates.pebble.loader.ClasspathLoader
import io.pebbletemplates.pebble.tokenParser.IncludeTokenParser
import io.pebbletemplates.pebble.tokenParser.TokenParser
import java.io.StringWriter

/**
 * Pebble template rendering middleware.
 * Adds a render() function to the Context via state.
 *
 * Security: The `include` tag is disabled to mitigate CVE in Pebble <= 3.2.3
 * (Arbitrary Local File Inclusion via `include` macro). Only `extends` is allowed.
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
            .registerExtensionCustomizer { ext -> DisableIncludeCustomizer(ext) }
            .build()
    }

    override fun invoke(ctx: Context, next: Next) {
        ctx.setState("pebbleEngine", engine)
        next()
    }
}

/**
 * Removes the `include` token parser to prevent Local File Inclusion attacks.
 */
private class DisableIncludeCustomizer(delegate: Extension) : ExtensionCustomizer(delegate) {
    override fun getTokenParsers(): List<TokenParser> {
        return super.getTokenParsers().filter { it !is IncludeTokenParser }
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
