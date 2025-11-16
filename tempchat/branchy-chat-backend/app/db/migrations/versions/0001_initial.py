from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";")

    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("name", sa.String(255)),
        sa.Column("api_key", sa.String(255), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    op.create_table(
        "conversations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("title", sa.String(255)),
        sa.Column("system_prompt", sa.Text),
        sa.Column("model_key", sa.String(255)),
        sa.Column("meta", sa.JSON),
        sa.Column("archived", sa.Boolean, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("conversation_id", sa.String(64), sa.ForeignKey("conversations.id", ondelete="CASCADE"), index=True),
        sa.Column("parent_id", sa.Integer, sa.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("content", sa.Text),
        sa.Column("meta", sa.JSON),
        sa.Column("tokens", sa.Integer),
        sa.Column("cost", sa.Float),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    op.create_table(
        "branches",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("conversation_id", sa.String(64), sa.ForeignKey("conversations.id", ondelete="CASCADE")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("root_message_id", sa.Integer, sa.ForeignKey("messages.id", ondelete="SET NULL")),
        sa.Column("meta", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    op.create_table(
        "actions",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(128), unique=True, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("prompt", sa.Text, nullable=False),
        sa.Column("parameters_schema", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )

    op.create_table(
        "templates",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(128), unique=True, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("template", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()")),
    )


def downgrade():
    op.drop_table("templates")
    op.drop_table("actions")
    op.drop_table("branches")
    op.drop_table("messages")
    op.drop_table("conversations")
    op.drop_table("users")