import json

d = json.load(open('/tmp/revs.json'))
revs = d.get('revisions', d if isinstance(d, list) else [])
r = revs[0]
print('latest rev:', r.get('revision'), r.get('status'))
m = r.get('manifest') or {}
print('canvas:', m.get('width'), 'x', m.get('height'))
for wgt in (m.get('widgets') or []):
    cfg = wgt.get('config') or {}
    css = str(cfg.get('css', ''))
    print('---', wgt.get('id'), wgt.get('type'), 'backgroundColor:', repr(cfg.get('backgroundColor')))
    import re
    for mt in re.finditer(r'([^{}]+)\{([^}]*)\}', css):
        sel, body = mt.group(1).strip(), mt.group(2)
        bglines = [l.strip() for l in body.split(';') if 'background' in l]
        if bglines:
            print('   ', sel, '=>', bglines)


