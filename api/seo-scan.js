export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { urls = [], checkSiteFiles = false, discoverDomain = '' } = req.body || {};

  // MODE A: Discover all live URLs on a domain (via sitemap.xml + homepage links)
  if (discoverDomain) {
    try {
      const origin = new URL(discoverDomain).origin;
      const urlSet = new Set([origin + '/']);

      // 1. Check /sitemap.xml and /sitemap_index.xml
      for (const smPath of ['/sitemap.xml', '/sitemap_index.xml', '/page-sitemap.xml', '/post-sitemap.xml']) {
        try {
          const smRes = await fetch(origin + smPath, { headers: { 'User-Agent': 'Vidscola-SEO-Audit-Bot/1.0' } });
          if (smRes.ok) {
            const xml = await smRes.text();
            const locs = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim());
            for (const loc of locs) {
              if (loc.endsWith('.xml')) {
                // Nested sub-sitemap (Yoast / RankMath)
                try {
                  const subRes = await fetch(loc, { headers: { 'User-Agent': 'Vidscola-SEO-Audit-Bot/1.0' } });
                  if (subRes.ok) {
                    const subXml = await subRes.text();
                    const subLocs = [...subXml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim());
                    subLocs.forEach(u => { if (u.startsWith(origin) && !u.endsWith('.xml')) urlSet.add(u); });
                  }
                } catch (_) {}
              } else if (loc.startsWith(origin)) {
                urlSet.add(loc);
              }
            }
          }
        } catch (_) {}
      }

      // 2. Also extract internal <a href> links from the homepage navigation/body
      try {
        const homeRes = await fetch(origin + '/', { headers: { 'User-Agent': 'Vidscola-SEO-Audit-Bot/1.0' } });
        if (homeRes.ok) {
          const homeHtml = await homeRes.text();
          const hrefs = [...homeHtml.matchAll(/href=["']([^"'#?]+)["']/gi)].map(m => m[1].trim());
          for (const h of hrefs) {
            if (h.startsWith('/') && !h.startsWith('//')) {
              if (!/\.(jpg|jpeg|png|gif|webp|svg|pdf|css|js|ico|xml)$/i.test(h)) {
                urlSet.add(origin + h);
              }
            } else if (h.startsWith(origin)) {
              if (!/\.(jpg|jpeg|png|gif|webp|svg|pdf|css|js|ico|xml)$/i.test(h)) {
                urlSet.add(h);
              }
            }
          }
        }
      } catch (_) {}

      const allUrls = [...urlSet].slice(0, 120);
      const discovered = [];

      // Fetch page titles in parallel batches of 12
      for (let i = 0; i < allUrls.length; i += 12) {
        const batch = allUrls.slice(i, i + 12);
        const batchRes = await Promise.all(batch.map(async (u) => {
          try {
            const r = await fetch(u, { headers: { 'User-Agent': 'Vidscola-SEO-Audit-Bot/1.0' }, redirect: 'follow' });
            if (!r.ok) return null;
            const pageHtml = await r.text();
            const tMatch = pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const h1Match = pageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
            const rawTitle = tMatch ? tMatch[1].replace(/\s+/g, ' ').trim() : (h1Match ? h1Match[1].replace(/<[^>]+>/g, '').trim() : '');
            return { url: u, title: rawTitle };
          } catch (_) {
            return null;
          }
        }));
        batchRes.filter(Boolean).forEach(item => discovered.push(item));
      }

      return res.status(200).json({ discovered });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // MODE B: Detailed SEO Audit of specific URLs
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
