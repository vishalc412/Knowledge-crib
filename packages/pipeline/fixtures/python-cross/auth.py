"""Auth module — imports from sibling modules (relative package imports)."""

from .base import Base
from .util import format_token


class Auth(Base):
    """Auth service."""

    def issue(self, user):
        return format_token(user)


def make_auth():
    return Auth()