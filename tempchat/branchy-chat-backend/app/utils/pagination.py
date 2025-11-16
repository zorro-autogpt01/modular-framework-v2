from typing import Iterable

def paginate(items: Iterable, limit: int):
    lst = list(items)
    return lst[:limit]