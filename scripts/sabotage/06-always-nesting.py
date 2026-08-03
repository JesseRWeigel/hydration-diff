# Name a cause on every run, including the clean ones.
import pathlib
p = pathlib.Path('src/causes.js')
s = p.read_text()
old = "  if (repairOps.length > 0) {"
new = "  if (true) {"
assert old in s, 'anchor not found'
p.write_text(s.replace(old, new))
