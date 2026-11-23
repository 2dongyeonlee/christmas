// 정자동의 크리스마스 — Cloudflare Worker (static assets + D1 storage API)
const IDS = ["JH", "JE", "DY", "WI", "KB", "EJ"];
const MAX_NOTES = 400;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, at TEXT NOT NULL)"
  ).run();
  ready = true;
}
const now = () => new Date().toISOString();
const getRow = async (env, k) => {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return r ? JSON.parse(r.v) : null;
};
const insertOnly = (env, k, v) =>
  env.DB.prepare("INSERT INTO kv (k,v,at) VALUES (?,?,?) ON CONFLICT(k) DO NOTHING")
    .bind(k, JSON.stringify(v), now()).run();
const upsert = (env, k, v) =>
  env.DB.prepare("INSERT INTO kv (k,v,at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, at=excluded.at")
    .bind(k, JSON.stringify(v), now()).run();
const del = (env, k) => env.DB.prepare("DELETE FROM kv WHERE k=?").bind(k).run();

function isAdmin(req, env) {
  const k = req.headers.get("x-admin") || "";
  return !!env.ADMIN_KEY && k.length > 0 && k === env.ADMIN_KEY;
}
function resetOk(req, env) {
  const code = env.RESET_CODE || "1234";
  return (req.headers.get("x-reset") || "") === code;
}
function groupOk(req, env) {
  if (!env.GROUP_CODE) return true;
  return (req.headers.get("x-group") || "") === env.GROUP_CODE;
}

async function api(req, env, u) {
  await init(env);
  const admin = isAdmin(req, env);
  const parts = u.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [col, id] = parts;
  const m = req.method;

  if (m === "GET" && col === "state") {
    if (!groupOk(req, env) && !admin) return json({ error: "group" }, 401);
    const { results } = await env.DB.prepare("SELECT k, v FROM kv").all();
    const out = { people: {}, notes: [], draw: null, reveals: {}, admin, group: !!env.GROUP_CODE };
    for (const r of results) {
      const v = JSON.parse(r.v);
      const [c, key] = r.k.split("/");
      if (c === "people" && IDS.includes(key)) out.people[key] = v;
      else if (c === "notes") out.notes.push(v);
      else if (c === "draw" && key === "current") out.draw = v;
      else if (c === "reveals" && IDS.includes(key)) out.reveals[key] = v;
    }
    return json(out);
  }

  if (!["POST", "PUT", "DELETE"].includes(m)) return json({ error: "method" }, 405);
  if (!groupOk(req, env) && !admin) return json({ error: "group" }, 401);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 16000) return json({ error: "too_large" }, 413);
  const body = m === "DELETE" ? null : await req.json().catch(() => null);
  if (m !== "DELETE" && (!body || typeof body !== "object")) return json({ error: "body" }, 400);

  // notes: add only
  if (col === "notes" && m === "POST" && !id) {
    const { to, ek, iv, ct } = body;
    if (!IDS.includes(to) || !str(ek, 1200) || !str(iv, 64) || !str(ct, 6000)) return json({ error: "invalid" }, 400);
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'notes/%'").first();
    if (c && c.n >= MAX_NOTES) return json({ error: "quota" }, 429);
    await insertOnly(env, "notes/" + crypto.randomUUID(), { to, at: now(), ek, iv, ct });
    return json({ ok: true });
  }

  // people/{ID}: create once; afterwards only the hint can change (same public key)
  if (col === "people" && IDS.includes(id)) {
    const k = "people/" + id;
    if (m === "DELETE") {
      if (!admin) return json({ error: "admin" }, 403);
      await del(env, k);
      return json({ ok: true });
    }
    const { hint = "", pub, wrap } = body;
    if (typeof hint !== "string" || hint.length > 40) return json({ error: "invalid" }, 400);
    if (!pub || !str(pub.n, 1000) || !str(pub.e, 16) || !wrap || !str(wrap.salt, 64) || !str(wrap.iv, 64) || !str(wrap.data, 3000))
      return json({ error: "invalid" }, 400);
    const cur = await getRow(env, k);
    if (cur && cur.pub && cur.pub.n !== pub.n && !admin) return json({ error: "exists" }, 409);
    await upsert(env, k, { hint, pub: { kty: "RSA", n: pub.n, e: pub.e }, wrap: { salt: wrap.salt, iv: wrap.iv, data: wrap.data }, updatedAt: now() });
    return json({ ok: true });
  }

  // draw/current: single draw (atomic create), admin reset
  if (col === "draw" && id === "current") {
    if (m === "DELETE") {
      if (!admin && !resetOk(req, env)) return json({ error: "admin" }, 403);
      await del(env, "draw/current");
      return json({ ok: true });
    }
    const t = body.targets;
    if (!t || typeof t !== "object" || !IDS.every((x) => str(t[x], 1200))) return json({ error: "invalid" }, 400);
    const targets = Object.fromEntries(IDS.map((x) => [x, t[x]]));
    const r = await insertOnly(env, "draw/current", { targets, at: now() });
    if (!r.meta || r.meta.changes === 0) return json({ error: "exists" }, 409);
    return json({ ok: true });
  }

  // reveals/{ID}: write once, admin reset
  if (col === "reveals" && IDS.includes(id)) {
    const k = "reveals/" + id;
    if (m === "DELETE") {
      if (!admin && !resetOk(req, env)) return json({ error: "admin" }, 403);
      await del(env, k);
      return json({ ok: true });
    }
    if (!IDS.includes(body.to)) return json({ error: "invalid" }, 400);
    const r = await insertOnly(env, k, { to: body.to, at: now() });
    if (!r.meta || r.meta.changes === 0) return json({ error: "exists" }, 409);
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) {
      try {
        return await api(req, env, u);
      } catch (e) {
        return json({ error: "server" }, 500);
      }
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      const r = await env.ASSETS.fetch(new URL("/app.html", u.origin));
      const html = (await r.text()).replaceAll("__ORIGIN__", u.origin);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return env.ASSETS.fetch(req);
  },
};
