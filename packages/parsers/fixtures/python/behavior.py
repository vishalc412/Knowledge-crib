"""Fixture for schema-1.2 behavior nodes: raise, exception-handler, assignment, case-branch, explanation."""


def process(value):
    """Process a value, raising on invalid input."""
    result = value * 2
    try:
        if result < 0:
            raise ValueError("negative result")
        return result
    except ValueError as e:
        return -1
    except (TypeError, KeyError) as e:
        return -2


def classify(point):
    """Classify a point via structural matching."""
    match point:
        case Point(x=0, y=0):
            return "origin"
        case Point(x=0, y=_):
            return "on y-axis"
        case _:
            return "other"