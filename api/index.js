const { createClient } = require('@supabase/supabase-js')

const PLATFORMS = ['x', 'bluesky', 'youtube', 'note', 'qiita', 'zenn']

function jstNow() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  const token = req.query.key || req.headers['x-dashboard-key']
  const pw = req.query.pw
  if (!(token && token === process.env.DASHBOARD_SECRET) && !(pw && pw === process.env.DASHBOARD_PASSWORD)) {
    res.status(401).send('Unauthorized')
    return
  }

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    const since = new Date()
    since.setDate(since.getDate() - 30)

    const [postsRes, costRes, reportsRes] = await Promise.all([
      db.from('vira_posts')
        .select('platform, likes, retweets, views, replies, posted_at, content, content_type, quality_score, status')
        .gte('posted_at', since.toISOString())
        .order('posted_at', { ascending: false }),
      db.from('vira_cost_log')
        .select('cost_usd')
        .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
      db.from('vira_weekly_reports')
        .select('*')
        .order('week_start', { ascending: false })
        .limit(4),
    ])

    const posts = (postsRes.data || []).filter(p => p.status === 'posted')
    const monthlyCost = (costRes.data || []).reduce((s, r) => s + Number(r.cost_usd), 0)
    const weeklyReports = reportsRes.data || []

    const summary = {
      totalPosts: posts.length,
      totalLikes: posts.reduce((s, p) => s + (p.likes || 0), 0),
      totalRetweets: posts.reduce((s, p) => s + (p.retweets || 0), 0),
      totalViews: posts.reduce((s, p) => s + (p.views || 0), 0),
    }

    const pfStats = {}
    for (const pf of PLATFORMS) {
      const pfPosts = posts.filter(p => p.platform === pf)
      const total = pfPosts.length
      const posted = pfPosts.filter(p => p.status === 'posted').length
      pfStats[pf] = {
        total, posted,
        successRate: total > 0 ? ((posted / total) * 100).toFixed(1) : '0.0',
        avgLikes: total > 0 ? (pfPosts.reduce((s, p) => s + (p.likes || 0), 0) / total).toFixed(1) : '0.0',
        avgViews: total > 0 ? (pfPosts.reduce((s, p) => s + (p.views || 0), 0) / total).toFixed(1) : '0.0',
      }
    }

    const dailyChart = {}
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      dailyChart[d.toISOString().slice(0, 10)] = 0
    }
    for (const p of posts) {
      if (!p.posted_at) continue
      const key = p.posted_at.slice(0, 10)
      if (key in dailyChart) dailyChart[key]++
    }

    const topPosts = [...posts]
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 10)
      .map(p => {
        let displayContent = (p.content || '').slice(0, 50)
        if (p.platform === 'youtube') {
          try { displayContent = JSON.parse(p.content).title || displayContent } catch {}
        }
        return { content: displayContent, platform: p.platform, likes: p.likes || 0, date: p.posted_at ? p.posted_at.slice(0, 10) : '-' }
      })

    const scored = posts.filter(p => p.quality_score != null)
    const qualityAvg = scored.length > 0 ? (scored.reduce((s, p) => s + p.quality_score, 0) / scored.length).toFixed(2) : '0'
    const qualityDist = { '0-2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8-10': 0 }
    for (const p of scored) {
      const q = p.quality_score
      if (q < 2) qualityDist['0-2']++
      else if (q < 4) qualityDist['2-4']++
      else if (q < 6) qualityDist['4-6']++
      else if (q < 8) qualityDist['6-8']++
      else qualityDist['8-10']++
    }

    const generatedAt = jstNow()

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    return res.json({
      summary, monthlyCost, pfStats, dailyChart, topPosts,
      quality: { avg: qualityAvg, dist: qualityDist },
      weeklyReports: weeklyReports.map(r => ({
        week_start: r.week_start, total_posts: r.total_posts,
        follower_change: r.follower_change, cost_usd: r.cost_usd,
      })),
      generatedAt,
    })
  } catch (err) {
    res.status(500).send('Dashboard generation error: ' + err.message)
  }
}
