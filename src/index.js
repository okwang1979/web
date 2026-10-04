import pageHtml from './site.html';

/**
 * maltor.xyz 独立站 —— Cloudflare Worker
 *   GET  /            -> 返回落地页（含联系/询价表单）
 *   POST /api/contact -> 校验后通过 Resend 发送邮件到 CONTACT_TO
 *   GET  /healthz     -> 健康检查
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// 字段长度上限，防止超长内容刷爆邮件
const LIMITS = {
  name: 80,
  email: 120,
  company: 120,
  topic: 40,
  budget: 40,
  message: 4000,
};

// 询价类型白名单
const TOPICS = ['网站开发', '小程序 / App', '系统对接 / API', '运维 / 部署', '其他'];

// 简易内存限流：同一 IP 10 分钟内最多 5 次
// 注意：Workers 每个实例内存独立，这是"尽力而为"的软限制，
// 真要硬限流请上 Cloudflare Rate Limiting 规则或 WAF。
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // 防止 Map 无限增长
  return recent.length > RATE_MAX;
}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}
function nl2br(value) {
  return esc(value).replace(/\r?\n/g, '<br>');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Origin 是否放行：
 *   1. 精确命中 ALLOWED_ORIGINS（本地开发地址放这里）
 *   2. 或者属于 SITE_DOMAIN 本身 / 它的任意子域（maltor.xyz、www.、message. 都放行）
 * 用 hostname 后缀判断，不会误放行 "evil-maltor.xyz" 这类域名。
 */
function isAllowedOrigin(origin, env) {
  if (!origin) return false;

  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;

  const siteDomain = env.SITE_DOMAIN || 'maltor.xyz';
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    return hostname === siteDomain || hostname.endsWith('.' + siteDomain);
  } catch {
    return false;
  }
}

/** 校验提交内容，返回 { ok, values } 或 { ok:false, error } */
function validate(body) {
  const values = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const raw = typeof body[field] === 'string' ? body[field].trim() : '';
    if (raw.length > max) {
      return { ok: false, error: `字段「${field}」内容过长（上限 ${max} 字符）` };
    }
    values[field] = raw;
  }

  if (!values.name) return { ok: false, error: '请填写称呼' };
  if (!values.email) return { ok: false, error: '请填写邮箱' };
  if (!EMAIL_RE.test(values.email)) return { ok: false, error: '邮箱格式不正确' };
  if (!values.message || values.message.length < 10) {
    return { ok: false, error: '需求描述至少 10 个字，方便我这边判断能不能接' };
  }
  if (values.topic && !TOPICS.includes(values.topic)) {
    values.topic = '其他'; // 非法值兜底，不因它拒绝整条提交
  }
  return { ok: true, values };
}

/** 组装发给自己的通知邮件 */
function buildEmail(values, meta) {
  const topic = values.topic || '未选择';
  const subject = `[Maltor 新询价] ${topic} - ${values.name}`;
  const html = `
<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.6;color:#1f2328;max-width:640px">
  <h2 style="margin:0 0 16px;font-size:18px">收到一条新的联系/询价</h2>
  <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">
    <tr><td style="width:96px;color:#6b7280;background:#f6f8fa">称呼</td><td style="background:#f6f8fa"><b>${esc(values.name)}</b></td></tr>
    <tr><td style="color:#6b7280">邮箱</td><td><a href="mailto:${esc(values.email)}">${esc(values.email)}</a></td></tr>
    <tr><td style="color:#6b7280;background:#f6f8fa">公司 / 团队</td><td style="background:#f6f8fa">${esc(values.company) || '<span style="color:#9ca3af">未填</span>'}</td></tr>
    <tr><td style="color:#6b7280">需求类型</td><td>${esc(topic)}</td></tr>
    <tr><td style="color:#6b7280;background:#f6f8fa">预算区间</td><td style="background:#f6f8fa">${esc(values.budget) || '<span style="color:#9ca3af">未填</span>'}</td></tr>
  </table>
  <h3 style="margin:20px 0 8px;font-size:15px">需求描述</h3>
  <div style="padding:12px 14px;background:#f6f8fa;border-radius:6px;font-size:14px;white-space:normal">${nl2br(values.message)}</div>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
  <p style="font-size:12px;color:#9ca3af;margin:0">
    来源 IP：${esc(meta.ip)} ｜ 时间：${esc(meta.time)} ｜ UA：${esc(meta.ua)}
  </p>
  <p style="font-size:12px;color:#9ca3af;margin:6px 0 0">直接回复本邮件即可联系到对方（reply-to 已设为对方邮箱）。</p>
</div>`.trim();

  const text =
    `新询价 - ${topic}\n\n` +
    `称呼：${values.name}\n邮箱：${values.email}\n` +
    `公司：${values.company || '未填'}\n需求类型：${topic}\n预算：${values.budget || '未填'}\n\n` +
    `需求描述：\n${values.message}\n\n` +
    `来源 IP：${meta.ip}\n时间：${meta.time}\nUA：${meta.ua}`;

  return { subject, html, text };
}

async function sendViaResend(env, values, meta) {
  const { subject, html, text } = buildEmail(values, meta);

  const payload = {
    from: env.CONTACT_FROM,
    to: [env.CONTACT_TO],
    reply_to: values.email, // 直接回复 = 回复给访客
    subject,
    html,
    text,
  };

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Resend 返回失败', res.status, JSON.stringify(data));
    throw new Error(data?.message || `Resend 返回 ${res.status}`);
  }
  return data?.id || null;
}

async function handleContact(request, env) {
  // 1) 来源校验：只接受本站域名（含所有子域）提交
  //    防的是随手扫接口的脚本；Origin 可伪造，硬防护靠限流
  if (!isAllowedOrigin(request.headers.get('Origin'), env)) {
    return json({ ok: false, error: '非法来源' }, 403);
  }

  // 2) 限流
  const ip = clientIp(request);
  if (rateLimited(ip)) {
    return json({ ok: false, error: '提交太频繁了，请稍后再试' }, 429);
  }

  // 3) 解析 body
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求格式错误' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: '请求格式错误' }, 400);
  }

  // 4) 蜜罐：正常用户看不到也填不到这个字段
  if (body.website) {
    return json({ ok: true }); // 假装成功，别给机器人反馈
  }

  // 5) 字段校验
  const result = validate(body);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 400);
  }

  // 6) 发信
  if (!env.RESEND_API_KEY) {
    console.error('未配置 RESEND_API_KEY');
    return json({ ok: false, error: '服务端未配置邮件服务' }, 500);
  }

  try {
    const id = await sendViaResend(env, result.values, {
      ip,
      time: new Date().toISOString(),
      ua: request.headers.get('User-Agent') || '-',
    });
    console.log('询价已发送', { email: result.values.email, id, ip });
    return json({ ok: true, id });
  } catch (err) {
    console.error('发送失败', err);
    return json({ ok: false, error: '邮件发送失败，请稍后重试或直接发邮件联系' }, 502);
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // 注意：connect-src 必须显式声明，否则会回退到 default-src 'none'，
  // 浏览器会直接封杀页面里的 fetch('/api/contact')，表单永远提交不了。
  // script-src 里的 static.cloudflareinsights.com 是 Cloudflare 自动注入的
  // 访问统计脚本（beacon.min.js），不放行会报 CSP 拦截，但不影响页面功能。
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline' https://static.cloudflareinsights.com; " +
    "style-src 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 预检请求（跨源调试 / www 跳转场景）
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      if (isAllowedOrigin(origin, env)) {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
          },
        });
      }
      return new Response(null, { status: 403 });
    }

    if (pathname === '/api/contact') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
      }
      return handleContact(request, env);
    }

    if (pathname === '/healthz') {
      return new Response('ok', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
      });
    }

    if (pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
      });
    }

    if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // www -> 主域，避免两份内容
    if (url.hostname === 'www.maltor.xyz') {
      return Response.redirect(`https://maltor.xyz${pathname}${url.search}`, 301);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ ok: false, error: 'Not Found' }, 404);
    }

    return new Response(pageHtml, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=3600',
        ...SECURITY_HEADERS,
      },
    });
  },
};
