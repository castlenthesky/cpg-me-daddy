RATE = 2
RATE = 3


def trace(fn):
    def wrapper():
        return fn()

    return wrapper


def scale(value, factor=RATE):
    total = compute(value)
    print(total, factor)
    return later(RATE, total)


def compute(n):
    return len(str(n))


@trace
def later(a, b):
    run = lambda: scale(a)
    return run()


class Box:
    size = compute(RATE)

    @trace
    def grow(self, by):
        self.resize(by)
        return Box()


result = scale(RATE)
print(result)
