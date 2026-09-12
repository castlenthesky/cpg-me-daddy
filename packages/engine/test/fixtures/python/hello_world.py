"""Greeting demo."""

GREETING = "Hello"


class Greeter:
    """Greets people."""

    prefix: str = "Hi"

    def __init__(self, prefix: str):
        self.prefix = prefix

    def greet(self, name: str) -> str:
        return f"{self.prefix}, {name}"


def greet_user(name: str) -> str:
    return f"{GREETING}, {name}"
