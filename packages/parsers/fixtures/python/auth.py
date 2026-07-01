"""Module docstring for the fixture."""
# a comment line

from base import Base


def helper(value):
    return value + 1


@log_calls
class Auth(Base):
    """Auth service."""

    def login(self, user):
        return self.issue(user)

    async def issue(self, user):
        tokens = helper(user)
        return tokens


def top_level():
    a = Auth()
    return a.login("x")