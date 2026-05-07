import json
import re
from app import create_app
from app.config import Config
from app.extension import db
from app.models import Post
import sqlite3

# https://github.com/brightmart/nlp_chinese_corpus
dataset_path = '/Users/neo/Downloads/baike2018qa/baike_qa_valid.json'


def wrap_with_paragraph(text):
    text = re.sub(r'(<br>|<BR>|\r\n|\r)+', '<br>', text)
    parts = text.split('<br>')
    wrapped_parts = [f'<p>{part.strip()}</p>' for part in parts]
    return ''.join(wrapped_parts)


def parse_dataset(filepath):
    for line in open(filepath, 'rt'):
        if not line.strip():
            continue
        item = json.loads(line)

        tag = (item.get('category') or item.get('topic', '')).replace('-', '/').strip()
        if not tag:
            tag = 'unknown'

        title = item['title']
        content = wrap_with_paragraph(item.get('answer') or item.get('content', ''))

        yield f"""<p><span class="hash-tag">#{tag}</span></p><h2>{title}</h2>{content}"""


def gen_sample_posts():
    app = create_app(Config.from_env())

    with app.app_context():
        for content in parse_dataset(dataset_path):
            post = Post(content=content)
            db.session.add(post)
        db.session.commit()


def check_sqlite_config():
    from sqlalchemy import text

    app = create_app(Config.from_env())
    with app.app_context():
        configs = {
            "foreign_keys": "PRAGMA foreign_keys",
            "journal_mode": "PRAGMA journal_mode",
            "synchronous": "PRAGMA synchronous",
            "wal_autocheckpoint": "PRAGMA wal_autocheckpoint",
        }

        for name, pragma in configs.items():
            try:
                result = db.session.execute(text(pragma)).fetchone()
                print(f"{name}: {result[0]}")
            except Exception as e:
                print(f"Error checking {name}: {e}")


def refresh_wal_checkpoint(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("PRAGMA wal_checkpoint(FULL);")
    result = cursor.fetchone()
    conn.close()
    print(f"WAL checkpoint result: {result}")


if __name__ == '__main__':
    # gen_sample_posts()
    # check_sqlite_config()
    refresh_wal_checkpoint('data/app-dev.db')
