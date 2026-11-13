export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { urls = [], checkSiteFiles = false } = req.body || {};
  const results = [];

  for (const rawUrl of urls.slice(0, 50)) {
    const url = String(rawUrl || '').trim();
    if (!url) continue;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Vidscola-SEO-Audit-Bot/1.0' },
        redirect: 'follow'
      });
      const html = await response.text();

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

      const descMatch =
        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
        html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
      const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '';

      const h1Matches = html.match(/<h1\b[^>]*>/gi) || [];
      const hasCanonical = /<link[^>]*rel=["']canonical["'][^>]*>/i.test(html);
      const hasSchema = /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(html);

      const imgTags = html.match(/<img\b[^>]*>/gi) || [];
      const missingAltCount = imgTags.filter(tag => !/\balt\s*=\s*["'][^"']+["']/i.test(tag)).length;

      results.push({
        url,
        status: response.status,
        title,
        description,
        h1Count: h1Matches.length,
        hasCanonical,
        hasSchema,
        missingAltCount
      });
    } catch (err) {
      results.push({
        url,
        status: 0,
        error: err.message,
        title: '',
        description: '',
        h1Count: 0,
        hasCanonical: false,
        hasSchema: false,
        missingAltCount: 0
      });
    }
  }

  let siteFiles = null;
  if (checkSiteFiles && urls.length) {
    try {
      const origin = new URL(urls[0]).origin;
      const [smRes, rbRes] = await Promise.all([
        fetch(origin + '/sitemap.xml').catch(() => ({ ok: false })),
        fetch(origin + '/robots.txt').catch(() => ({ ok: false }))
      ]);
      siteFiles = {
        sitemapOk: Boolean(smRes && smRes.ok),
        robotsOk: Boolean(rbRes && rbRes.ok)
      };
    } catch (_) {}
  }

  return res.status(200).json({ results, siteFiles });
}
