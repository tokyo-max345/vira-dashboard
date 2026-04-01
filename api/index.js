const { createClient } = require('@supabase/supabase-js')

const PLATFORMS = ['x', 'bluesky', 'note', 'qiita', 'zenn']

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  // トークン認証（API key or ダッシュボードパスワード）
  const token = req.query.key || req.headers['x-dashboard-key']
  const pw = req.query.pw
  if (!(token && token === process.env.DASHBOARD_SECRET) && !(pw && pw === process.env.DASHBOARD_PASSWORD)) {
    res.status(401).send('Unauthorized')
    return
  }

  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

    // データ取得（並列）
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

    const posts = postsRes.data || []
    const monthlyCost = (costRes.data || []).reduce((s, r) => s + Number(r.cost_usd), 0)
    const USD_JPY = 150
    const fmtCost = (usd) => `$${usd.toFixed(2)} (${Math.round(usd * USD_JPY).toLocaleString()}円)`
    const weeklyReports = reportsRes.data || []

    // 集計（posted済みのみ — draft/failedのlikes=0が希釈するのを防ぐ）
    const postedPosts = posts.filter(p => p.status === 'posted')
    const summary = {
      totalPosts: postedPosts.length,
      totalLikes: postedPosts.reduce((s, p) => s + (p.likes || 0), 0),
      totalRetweets: postedPosts.reduce((s, p) => s + (p.retweets || 0), 0),
      totalViews: postedPosts.reduce((s, p) => s + (p.views || 0), 0),
    }

    const pfStats = {}
    for (const pf of PLATFORMS) {
      const pfPosts = posts.filter(p => p.platform === pf)
      const total = pfPosts.length
      const posted = pfPosts.filter(p => p.status === 'posted').length
      pfStats[pf] = {
        total,
        posted,
        successRate: total > 0 ? ((posted / total) * 100).toFixed(1) : '0.0',
        avgLikes: posted > 0 ? (pfPosts.filter(p => p.status === 'posted').reduce((s, p) => s + (p.likes || 0), 0) / posted).toFixed(1) : '0.0',
        avgViews: posted > 0 ? (pfPosts.filter(p => p.status === 'posted').reduce((s, p) => s + (p.views || 0), 0) / posted).toFixed(1) : '0.0',
      }
    }

    // 日別チャート
    const dailyChart = {}
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      dailyChart[d.toISOString().slice(0, 10)] = 0
    }
    for (const p of posts) {
      if (!p.posted_at) continue
      const key = p.posted_at.slice(0, 10)
      if (key in dailyChart) dailyChart[key]++
    }

    // トップ投稿（posted済みのみ）
    const topPosts = [...postedPosts]
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 10)
      .map(p => ({
        content: (p.content || '').slice(0, 50),
        platform: p.platform,
        likes: p.likes || 0,
        date: p.posted_at ? p.posted_at.slice(0, 10) : '-',
      }))

    // 品質スコア
    const scored = posts.filter(p => p.quality_score != null)
    const qualityAvg = scored.length > 0
      ? (scored.reduce((s, p) => s + p.quality_score, 0) / scored.length).toFixed(2)
      : '0'
    const qualityDist = { '0-2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8-10': 0 }
    for (const p of scored) {
      const q = p.quality_score
      if (q < 2) qualityDist['0-2']++
      else if (q < 4) qualityDist['2-4']++
      else if (q < 6) qualityDist['4-6']++
      else if (q < 8) qualityDist['6-8']++
      else qualityDist['8-10']++
    }

    // JSON返却モード
    if (req.query.format === 'json') {
      res.setHeader('Content-Type', 'application/json')
      return res.json({
        summary, monthlyCost, pfStats, dailyChart, topPosts,
        quality: { avg: qualityAvg, dist: qualityDist },
        weeklyReports: weeklyReports.map(r => ({
          week_start: r.week_start, total_posts: r.total_posts,
          follower_change: r.follower_change, cost_usd: r.cost_usd,
        })),
        generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      })
    }

    // HTML生成
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const dailyEntries = Object.entries(dailyChart)
    const maxDaily = Math.max(...dailyEntries.map(([, v]) => v), 1)
    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Viralana Dashboard</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <style>body { background: #0f172a; color: #e2e8f0; }</style>
</head>
<body class="min-h-screen p-4 md:p-8">
  <div class="max-w-6xl mx-auto">
    <div class="flex items-center justify-between mb-8">
      <h1 class="text-3xl font-bold">Viralana Dashboard</h1>
      <span class="text-sm text-gray-500">${esc(generatedAt)}</span>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
      ${[
        ['投稿数', summary.totalPosts, 'bg-blue-900'],
        ['いいね', summary.totalLikes, 'bg-pink-900'],
        ['RT/リポスト', summary.totalRetweets, 'bg-green-900'],
        ['ビュー', summary.totalViews, 'bg-purple-900'],
        ['月間コスト', fmtCost(monthlyCost), 'bg-yellow-900'],
      ].map(([label, value, bg]) => `
        <div class="${bg} rounded-xl p-5 text-center">
          <div class="text-gray-400 text-sm">${label}</div>
          <div class="text-2xl font-bold mt-1">${esc(String(value))}</div>
        </div>`).join('')}
    </div>

    <!-- PF別 -->
    <div class="mb-8">
      <h2 class="text-xl font-bold mb-3">PF別パフォーマンス</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="border-b border-gray-700 text-gray-400">
            <th class="py-2 text-left">Platform</th>
            <th class="py-2 text-right">投稿数</th>
            <th class="py-2 text-right">平均いいね</th>
            <th class="py-2 text-right">平均ビュー</th>
            <th class="py-2 text-right">成功率</th>
          </tr></thead>
          <tbody>
            ${PLATFORMS.map(pf => {
              const s = pfStats[pf]
              return `<tr class="border-b border-gray-800">
                <td class="py-2 font-medium">${esc(pf)}</td>
                <td class="py-2 text-right">${s.total}</td>
                <td class="py-2 text-right">${s.avgLikes}</td>
                <td class="py-2 text-right">${s.avgViews}</td>
                <td class="py-2 text-right">${s.successRate}%</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 日別チャート -->
    <div class="mb-8">
      <h2 class="text-xl font-bold mb-3">日別投稿数（直近30日）</h2>
      <div class="flex items-end gap-1" style="height:160px;">
        ${dailyEntries.map(([date, count]) => {
          const pct = maxDaily > 0 ? (count / maxDaily) * 100 : 0
          return `<div class="flex flex-col items-center flex-1 min-w-0" title="${esc(date)}: ${count}件">
            <div class="text-xs text-gray-500 mb-1">${count || ''}</div>
            <div class="w-full bg-blue-500 rounded-t" style="height:${Math.max(pct, 2)}%;min-height:2px;"></div>
            <div class="text-xs text-gray-600 mt-1 truncate w-full text-center" style="font-size:9px;">${date.slice(5)}</div>
          </div>`
        }).join('')}
      </div>
    </div>

    <!-- トップ投稿 -->
    <div class="mb-8">
      <h2 class="text-xl font-bold mb-3">トップ投稿 (いいね数)</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="border-b border-gray-700 text-gray-400">
            <th class="py-2 text-left">#</th>
            <th class="py-2 text-left">内容</th>
            <th class="py-2 text-left">PF</th>
            <th class="py-2 text-right">いいね</th>
            <th class="py-2 text-right">日付</th>
          </tr></thead>
          <tbody>
            ${topPosts.map((p, i) => `
              <tr class="border-b border-gray-800">
                <td class="py-2 text-gray-500">${i + 1}</td>
                <td class="py-2">${esc(p.content)}</td>
                <td class="py-2">${esc(p.platform)}</td>
                <td class="py-2 text-right font-medium text-pink-400">${p.likes}</td>
                <td class="py-2 text-right text-gray-400">${p.date}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 品質スコア -->
    <div class="mb-8">
      <h2 class="text-xl font-bold mb-3">品質スコア分布（平均: ${qualityAvg}）</h2>
      <div class="flex items-end gap-3" style="height:120px;">
        ${Object.entries(qualityDist).map(([range, count]) => {
          const maxQ = Math.max(...Object.values(qualityDist), 1)
          const pct = (count / maxQ) * 100
          return `<div class="flex flex-col items-center flex-1">
            <div class="text-xs text-gray-400 mb-1">${count}</div>
            <div class="w-full bg-emerald-600 rounded-t" style="height:${Math.max(pct, 2)}%;min-height:2px;"></div>
            <div class="text-xs text-gray-500 mt-1">${range}</div>
          </div>`
        }).join('')}
      </div>
    </div>

    <!-- 週次トレンド -->
    ${weeklyReports.length > 0 ? `
    <div class="mb-8">
      <h2 class="text-xl font-bold mb-3">週次トレンド（直近4週）</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="border-b border-gray-700 text-gray-400">
            <th class="py-2 text-left">週</th>
            <th class="py-2 text-right">投稿数</th>
            <th class="py-2 text-right">フォロワー変動</th>
            <th class="py-2 text-right">コスト</th>
          </tr></thead>
          <tbody>
            ${weeklyReports.map(r => `
              <tr class="border-b border-gray-800">
                <td class="py-2">${esc(r.week_start || '-')}</td>
                <td class="py-2 text-right">${r.total_posts ?? '-'}</td>
                <td class="py-2 text-right">${r.follower_change != null ? (r.follower_change >= 0 ? '+' : '') + r.follower_change : '-'}</td>
                <td class="py-2 text-right">${r.cost_usd != null ? fmtCost(Number(r.cost_usd)) : '-'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <footer class="text-center text-gray-600 text-xs mt-12 pb-4">
      Viralana &mdash; SNS Automation Dashboard
    </footer>
  </div>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(html)
  } catch (err) {
    res.status(500).send('Dashboard generation error: ' + err.message)
  }
}
