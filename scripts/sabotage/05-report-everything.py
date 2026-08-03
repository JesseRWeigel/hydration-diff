# Make the detector cry wolf: report every text node as changed whether it changed or not.
# A detector that fires on everything is useless, and only a negative control catches it.
import pathlib
p = pathlib.Path('src/diff.js')
s = p.read_text()
old = """    if (a.t === 'text') {
      if (a.value !== b.value) {"""
new = """    if (a.t === 'text') {
      if (true) {"""
assert old in s, 'anchor not found'
p.write_text(s.replace(old, new))
