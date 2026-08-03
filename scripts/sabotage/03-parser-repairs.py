# Make the "authored" parser behave like a browser: close an open <p> when a block element starts.
# The emitted tree then equals the parsed tree, the parser-repair diff goes empty, and the most
# valuable finding in the project silently stops being made.
import pathlib
p = pathlib.Path('src/html.js')
s = p.read_text()
old = """    const node = { t: 'el', tag, attrs, children: [] };
    push(node);"""
new = """    const BLOCK = new Set(['div', 'p', 'ul', 'ol', 'section', 'article', 'table', 'form']);
    if (BLOCK.has(tag)) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === 'p') { stack.length = k; break; }
      }
    }
    const node = { t: 'el', tag, attrs, children: [] };
    push(node);"""
assert old in s, 'anchor not found'
p.write_text(s.replace(old, new))
