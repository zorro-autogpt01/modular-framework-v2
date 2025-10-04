#!/usr/bin/env python3
import sys
from pathlib import Path

def is_escaped(s: str, i: int) -> bool:
    """Return True if character at index i is escaped by an odd number of backslashes."""
    b = 0
    j = i - 1
    while j >= 0 and s[j] == '\\':
        b += 1
        j -= 1
    return (b % 2) == 1

def first_colon_outside_quotes(s: str) -> int:
    """Find first ':' that is not inside a quoted string."""
    in_str = False
    for i, ch in enumerate(s):
        if ch == '"' and not is_escaped(s, i):
            in_str = not in_str
        if ch == ':' and not in_str:
            return i
    return -1

def last_unescaped_quote(s: str, start: int) -> int:
    """Find last unescaped quote in s[start:], return absolute index or -1."""
    last = -1
    for i in range(start, len(s)):
        if s[i] == '"' and not is_escaped(s, i):
            last = i
    return last

def escape_inner_quotes(segment: str) -> str:
    """
    Given a JSON string segment like:  "foo "bar" baz",
    return the same with inner unescaped quotes escaped: "foo \"bar\" baz"
    Assumes segment begins and ends with unescaped double quotes on a single line.
    """
    if len(segment) < 2 or segment[0] != '"' or segment[-1] != '"':
        return segment

    # Walk and escape only unescaped " that are not the first or last delimiter
    out = []
    for i, ch in enumerate(segment):
        if ch == '"' and i not in (0, len(segment) - 1) and not is_escaped(segment, i):
            out.append('\\"')
        else:
            out.append(ch)
    return ''.join(out)

def escape_inner_quotes_and_controls(segment: str) -> str:
    # segment starts and ends with unescaped "
    out = []
    for i, ch in enumerate(segment):
        if ch == '"' and i not in (0, len(segment) - 1) and not is_escaped(segment, i):
            out.append('\\"')
        elif ch == '\n':
            out.append('\\n')
        elif ch == '\r':
            out.append('\\r')
        elif ch == '\t':
            out.append('\\t')
        else:
            out.append(ch)
    return ''.join(out)

def fix_line(line: str) -> str:
    """
    Fix a single JSON line of the form `"key": "value",` where the "value"
    may contain unescaped quotes. Only touches the value string after the first ':'.
    """
    colon = first_colon_outside_quotes(line)
    if colon == -1:
        return line

    # Split into left part (`...: `) and right part (the value + possible trailing , } ] etc.)
    left = line[:colon + 1]
    right = line[colon + 1:]

    # Skip whitespace
    i = 0
    while i < len(right) and right[i].isspace():
        i += 1

    if i >= len(right) or right[i] != '"':
        # Not a single-line quoted value; leave untouched (numbers, booleans, arrays, objects).
        return line

    # Heuristic: assume the closing quote is the LAST unescaped quote on the line
    # (valid for single-line value strings typical of this schema).
    start = i
    abs_start = colon + 1 + start
    abs_end = last_unescaped_quote(line, abs_start)
    if abs_end == -1 or abs_end == abs_start:
        # Couldn’t find a closing quote; leave line as-is.
        return line

    # Rebuild: left + fixed "segment" + remainder
    segment = line[abs_start:abs_end + 1]
    fixed_segment = escape_inner_quotes_and_controls(segment)
    return line[:abs_start] + fixed_segment + line[abs_end + 1:]

def main():
    if len(sys.argv) < 2:
        print("Usage: fix_plan_strings.py <input.json> [<output.json>]", file=sys.stderr)
        sys.exit(1)

    inp = Path(sys.argv[1])
    data = inp.read_text(encoding="utf-8")

    fixed_lines = [fix_line(l) for l in data.splitlines()]
    fixed = "\n".join(fixed_lines)

    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(fixed, encoding="utf-8")
    else:
        sys.stdout.write(fixed)

if __name__ == "__main__":
    main()
