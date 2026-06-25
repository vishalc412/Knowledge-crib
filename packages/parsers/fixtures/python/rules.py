"""Track 3 fixture: guarded procedures + a loop, for statement/condition/CFG extraction."""


def honors():
    return "A"


def passing():
    return "B"


def failing():
    return "F"


def add(a, b):
    return a + b


def grade(score):
    if score >= 90:
        return honors()
    elif score >= 60:
        return passing()
    else:
        return failing()


def loop_count(items):
    total = 0
    for x in items:
        total = add(total, x)
    return total