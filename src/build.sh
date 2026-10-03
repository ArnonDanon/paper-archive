set -e
cat app.tsx store.tsx real.tsx main.tsx > bundle.tsx
npx esbuild bundle.tsx --loader:.tsx=tsx --jsx-factory=React.createElement --jsx-fragment=React.Fragment --target=es2019 --minify --outfile=app.js --log-level=warning
python3 - <<'EOF'
css=open('style.css').read(); js=open('app.js').read()
html=f'''<title>Paper Archive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Hebrew:wght@400;500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
{css}
</style>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>
{js}
</script>
'''
open('paper-archive.html','w').write(html)
EOF
