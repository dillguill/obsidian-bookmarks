// Local pages that reproduce the hard cases (lazy images, client-rendered SPA,
// endless page) so the capture pipeline can be checked without network access.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4599);
const para = (n) => Array.from({ length: n }, (_, i) =>
  `<p>Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>`).join('\n');
const svg = (label, hue) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300"><rect width="100%" height="100%" fill="hsl(${hue},60%,60%)"/><text x="40" y="160" font-size="48" font-family="sans-serif">${label}</text></svg>`)}`;

const pages = {
  '/lazy': `<!doctype html><html><head><title>Lazy images article</title>
<meta name="description" content="Article whose images load only when scrolled into view">
<meta name="author" content="Fixture Author"><link rel="canonical" href="http://127.0.0.1:${PORT}/lazy">
</head><body><nav>Home | About | Login</nav><article><h1>Lazy images article</h1>
${[1, 2, 3, 4, 5].map((n) => `${para(6)}<img alt="figure ${n}" data-src="${svg(`Figure ${n}`, n * 60)}" width="800" height="300">`).join('\n')}
</article><footer>Footer links, cookie banner text</footer>
<script>
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); }
}));
document.querySelectorAll('img[data-src]').forEach((img) => io.observe(img));
</script></body></html>`,
  '/spa': `<!doctype html><html><head><title>Loading…</title></head><body><div id="root">Loading…</div>
<script>
setTimeout(() => {
  document.title = 'Client-rendered post';
  document.getElementById('root').innerHTML =
    '<header>App shell</header><main><article><h1>Client-rendered post</h1>' + ${JSON.stringify(para(12))} + '<pre><code>const x = 1;</code></pre></article></main>';
}, 1200);
</script></body></html>`,
  '/spa-fetch': `<!doctype html><html><head><title>Loading…</title></head><body><div id="root">Loading…</div>
<script>
fetch('/api/post').then((r) => r.json()).then((p) => {
  document.title = p.title;
  document.getElementById('root').innerHTML = '<main><article><h1>' + p.title + '</h1>' + p.html + '</article></main>';
});
</script></body></html>`,
  '/endless': `<!doctype html><html><head><title>Endless feed</title></head><body><h1>Endless feed</h1><div id="feed"></div>
<script>
let n = 0;
const feed = document.getElementById('feed');
const more = () => { for (let i = 0; i < 20; i++) feed.insertAdjacentHTML('beforeend', '<p style="height:120px">Item ' + (++n) + '</p>'); };
more();
addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 400) more(); });
</script></body></html>`,
};

createServer((req, res) => {
  if (req.url === '/api/post') {
    // Slow API, like a real SPA's data call.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: 'Fetched post', html: para(10) }));
    }, 800);
    return;
  }
  const body = pages[req.url];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body ?? 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`fixtures on http://127.0.0.1:${PORT}`));
