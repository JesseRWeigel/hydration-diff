# Over-fold the normalisation: decode &nbsp; to an ordinary space instead of U+00A0.
#
# This is the tempting class of bug, because over-folding makes more runs look clean, and a
# suite made only of "this must report nothing" controls would go greener rather than redder.
#
# Written with an explicit escape on both sides. A first draft of this patch had the two
# characters typed literally, which made them the same byte, which made the replace a no-op,
# which would have produced a confident write-up about a check that was never exercised.
import pathlib
p = pathlib.Path('src/html.js')
s = p.read_text()
old = "nbsp: '\u00a0'"
new = "nbsp: '\u0020'"
assert old != new, 'the two sides are the same string, so this patch would do nothing'
assert old in s, 'anchor not found'
p.write_text(s.replace(old, new))
