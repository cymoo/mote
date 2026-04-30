from datetime import datetime, timedelta, UTC
from app.model import db, Post

from huey import crontab
from huey.contrib.mini import MiniHuey, logger

huey = MiniHuey()


@huey.task(crontab(minute='0', hour='3'))
def clear_posts():
    # It's not good to use `db.app` directly, but huey task context does not have Flask app context.
    with db.app.app_context():
        thirty_days_ago = datetime.now(UTC) - timedelta(days=30)
        deleted_count = Post.query.filter(
            Post.deleted_at < int(thirty_days_ago.timestamp() * 1000)
        ).delete()
        db.session.commit()

        if deleted_count:
            logger.info(f'[Daily] Deleted {deleted_count} posts.')


@huey.task(crontab(minute='*/30'))
def drive_purge_expired_uploads():
    with db.app.app_context():
        try:
            n = db.app.drive_upload_service.purge_expired()
            if n:
                logger.info(f'[Drive] Purged {n} expired upload sessions.')
        except Exception as e:
            logger.error(f'[Drive] purge expired uploads failed: {e}')


@huey.task(crontab(minute='*/30'))
def drive_purge_expired_shares():
    with db.app.app_context():
        try:
            n = db.app.drive_share_service.purge_expired()
            if n:
                logger.info(f'[Drive] Purged {n} expired shares.')
        except Exception as e:
            logger.error(f'[Drive] purge expired shares failed: {e}')


@huey.task(crontab(minute='30', hour='3'))
def drive_purge_old_trash():
    with db.app.app_context():
        try:
            cutoff = int(
                (datetime.now(UTC) - timedelta(days=30)).timestamp() * 1000
            )
            n = db.app.drive_service.purge_old_trash(cutoff)
            if n:
                logger.info(f'[Drive] Purged {n} old trash roots.')
        except Exception as e:
            logger.error(f'[Drive] purge old trash failed: {e}')
