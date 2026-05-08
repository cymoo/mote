from gevent import monkey

monkey.patch_all()
import click
from flask.cli import AppGroup, with_appcontext

from app import create_app
from app.config import Config
from app.extension import db

app = create_app(Config.from_env())
user_cli = AppGroup('user', help='user operations')


# Flask Cli Demo: https://flask.palletsprojects.com/en/2.0.x/cli/


@app.cli.command('create_tables', help='create tables')
def create_tables():
    db.create_all()


@app.cli.command('drop_tables', help='drop tables')
def drop_tables():
    if click.confirm('Are you sure to drop all tables?', default=False):
        db.drop_all()


# Test: command group
@user_cli.command('create', help='create a user')
@click.argument('name')
def create_user(name):
    # from app.models import User
    # user = User(name=name)
    # db.session.add(user)
    # db.session.commit()
    pass


# Test: push application context manually
@click.command('push_context', help='push context manually')
@with_appcontext
def push_context():
    print('push context manually')


app.cli.add_command(user_cli)
app.cli.add_command(push_context)


if __name__ == '__main__':
    app.run(port=8000)
