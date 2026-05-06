package site.daydream.mote.config

import jakarta.annotation.PostConstruct
import site.daydream.mote.interceptor.AuthInterceptor
import site.daydream.mote.service.AuthService
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.convert.ApplicationConversionService
import org.springframework.context.annotation.Configuration
import org.springframework.format.FormatterRegistry
import org.springframework.web.servlet.config.annotation.CorsRegistry
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import java.nio.file.Files
import java.nio.file.Paths
import kotlin.io.path.exists

@Configuration
// @EnableWebMvc
class WebConfig(
    private val cors: CorsProperties,
    private val uploadConfig: UploadConfig,
    private val authService: AuthService
) : WebMvcConfigurer {
    override fun addCorsMappings(registry: CorsRegistry) {
        val (origins, methods, headers, allowCredentials, maxAge) = cors

        registry.addMapping("/api/**")
            .allowedOrigins(*origins.toTypedArray())
            .allowedMethods(*methods.toTypedArray())
            .allowedHeaders(*headers.toTypedArray())
            .allowCredentials(allowCredentials)
            .maxAge(maxAge)

    }

    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        val (uploadUrl, uploadDir) = uploadConfig
        registry.addResourceHandler("/$uploadUrl/**")
            .addResourceLocations("file:$uploadDir/")
    }

    // https://www.baeldung.com/spring-boot-enum-mapping
    override fun addFormatters(registry: FormatterRegistry) {
        super.addFormatters(registry)
        // https://stackoverflow.com/questions/50231233/deserialize-enum-ignoring-case-in-spring-boot-controller
        // `ApplicationConversionService` comes with a set of configured converters and formatters.
        // It includes a converter that converts a string into an enum in a case-insensitive manner.

        // NOTE: This ONLY applies to query strings or form data. The case-insensitive feature for JSON needs additional configuration.
        ApplicationConversionService.configure(registry)
    }

    @Override
    override fun addInterceptors(registry: InterceptorRegistry) {
        registry.addInterceptor(AuthInterceptor(authService))
    }
}

@ConfigurationProperties(prefix = "web.cors")
data class CorsProperties(
    val allowedOrigins: List<String>,
    val allowedMethods: List<String>,
    val allowedHeaders: List<String>,
    val allowCredentials: Boolean,
    val maxAge: Long
)

@ConfigurationProperties(prefix = "web.upload")
data class UploadConfig(
    val uploadUrl: String,
    val uploadDir: String,
    val thumbnailSize: Int,
    val imageFormats: List<String>,
    val accelRedirectPrefix: String = "",
) {
    @PostConstruct
    fun init() {
        require(accelRedirectPrefix.isBlank() || accelRedirectPrefix.startsWith("/")) {
            "DRIVE_ACCEL_REDIRECT_PREFIX must start with '/'"
        }
        val path = Paths.get(uploadDir)
        if (!path.exists()) {
            Files.createDirectories(path)
        }
    }
}
