"""A module docstring."""

LIMIT: int = 3
_private = LIMIT


@register
def greet(name: str, times=1, *args, **kwargs) -> str:
    """Say hello.

    More text.
    """

    def inner():
        pass

    return name


async def fetch(url, /, *, timeout: float = 1.0):
    pass


@dataclass
class Greeter(Base):
    '''A greeter.'''

    greeting = "hello"
    a, b = 1, 2

    def __init__(self, name):
        self.name = name

    @property
    def label(self):
        return self.name

    @label.setter
    def label(self, value):
        self.name = value

    class Inner:
        size: int


class _Hidden:
    pass


LIMIT = 4
