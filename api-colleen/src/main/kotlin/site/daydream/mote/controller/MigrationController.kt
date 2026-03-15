package site.daydream.mote.controller

import io.github.cymoo.colleen.*
import site.daydream.mote.service.DatabaseService

@Controller("/migrations")
class MigrationController {

    @Get
    fun getMigrations(db: DatabaseService): List<Map<String, Any?>> {
        return db.getMigrationInfo()
    }

    @Post("/repair")
    fun repair(db: DatabaseService): Int {
        db.repairMigration()
        return 204
    }

    @Post("/migrate")
    fun migrate(db: DatabaseService): Int {
        db.migrate()
        return 204
    }
}
