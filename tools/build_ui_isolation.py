"""Regenerate module-owned cascade protection after changing styles/harvest.css."""
from pathlib import Path
import hashlib
import tinycss2

ROOT = Path(__file__).resolve().parents[1]

def protected_rules(rules, *, important):
    output = []
    for rule in rules:
        if rule.type == 'qualified-rule':
            declarations = tinycss2.parse_declaration_list(rule.content, skip_comments=True, skip_whitespace=True)
            selected = [d for d in declarations if d.type == 'declaration' and d.important == important]
            if not selected:
                continue
            selector = tinycss2.serialize(rule.prelude).strip()
            body = '\n'.join(f'    {d.name}: {tinycss2.serialize(d.value).strip()} !important;' for d in selected)
            output.append(f'  {selector} {{\n{body}\n  }}')
        elif rule.type == 'at-rule' and rule.content is not None:
            if rule.lower_at_keyword not in {'media', 'container', 'supports', 'layer'}:
                continue
            nested = protected_rules(tinycss2.parse_rule_list(rule.content, skip_comments=True, skip_whitespace=True), important=important)
            if nested:
                if rule.lower_at_keyword == 'layer':
                    output.append(nested)
                else:
                    output.append(f'  @{rule.at_keyword} {tinycss2.serialize(rule.prelude).strip()} {{\n{nested}\n  }}')
    return '\n'.join(output)

def build():
    source = (ROOT / 'styles/harvest.css').read_bytes()
    rules = tinycss2.parse_stylesheet(source.decode(), skip_comments=True, skip_whitespace=True)
    digest = hashlib.sha256(source).hexdigest()
    header = f'''/* Module-owned presentation boundary. Does not change other applications or theme settings.
   Generated from harvest.css; regenerate with python tools/build_ui_isolation.py.
   Source SHA256: {digest}
   Important layer precedence protects against unlayered theme overrides. Existing explicit
   overrides retain priority, and application positioning remains controlled by Foundry. */
@layer harvest-owned-ui {{
  @layer overrides {{
'''
    output = header + protected_rules(rules, important=True) + '\n  }\n  @layer defaults {\n' + protected_rules(rules, important=False) + '\n  }\n}\n'
    (ROOT / 'styles/ui-isolation.css').write_text(output)
    print('Generated module-owned UI isolation stylesheet')

if __name__ == '__main__':
    build()
